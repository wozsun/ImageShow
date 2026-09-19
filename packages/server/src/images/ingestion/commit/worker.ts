import { storageObjectKey } from "@imageshow/shared/browser";
import { ingestionPreparedPath, ingestionPreparedFiles } from "../raw/paths.ts";
import { withActiveIngestionTempPaths } from "../raw/lease-registry.ts";
import { updateIngestionExecutionProgress } from "../execution/session.ts";
import { contentType } from "../../../storage/objects/keys.ts";
import type { CompletedIngestionImageDto } from "@imageshow/shared/browser";
import { ApiError, errorMessage } from "../../../core/api-error.ts";
import {
  runWithAdvisoryLockAcquisitionSignal
} from "../../../core/database/advisory-locks.ts";
import { logger } from "../../../core/logger.ts";
import { randomUuidV7 } from "../../../core/uuid.ts";
import { resolveTagNames } from "../../../tags/query.ts";
import {
  invalidateEntityCountCaches,
  refreshEntityVocabularies
} from "../../../vocab/vocab-cache.ts";
import { vocabularyAssociationLockRequests } from "../../../vocab/mutation-sync.ts";
import {
  assertStorageWriteTarget,
  resolveStorageAccessForConfig
} from "../../../storage/backends/registry.ts";
import { thumbnailObjectKey } from "../../../storage/objects/image-paths.ts";
import {
  imageStorageMutationLockKey,
  tryWithStorageLocationReadAndAdvisoryLocks
} from "../../../storage/maintenance-lock.ts";
import {
  enqueueObjectsForCleanup,
  type MoveCleanupObjectInput
} from "../../../storage/cleanup/service.ts";
import {
  writeVerifiedFileToStorage
} from "../../../storage/objects/transfer.ts";
import { withImageMutationSync } from "../../mutation-sync.ts";
import { ingestionImageItemsWithTags } from "../../presenter.ts";
import { publishCompletedReceipt } from "./completion.ts";
import { ingestionContentLockKey } from "./duplicate-confirmation.ts";
import { persistIngestionImage } from "./persistence.ts";
import { removeIngestionPreparedFiles } from "../raw/prepared.ts";
import { ingestionCleanupRetryQueue } from "../cleanup/retry-queue.ts";
import {
  verifyCommitTargets,
  assertCurrentCommitExecution,
  assertCurrentDuplicateDecision
} from "./target-validation.ts";
import { withIngestionExecutionHeartbeat } from "../execution/heartbeat.ts";
import { IngestionIrreversibleCoordinator } from "../execution/irreversible-coordinator.ts";
import type { IngestionSessionSnapshot } from "../sessions/model.ts";
import { IngestionSessionRepository } from "../repository.ts";

export async function commitIngestionSessionSnapshot(
  repository: IngestionSessionRepository,
  coordinator: IngestionIrreversibleCoordinator,
  session: IngestionSessionSnapshot,
  signal: AbortSignal
) {
  if (
    session.status !== "committing"
    || !session.execution_token
    || !session.prepared
    || !session.commit
  ) throw new ApiError(409, "invalid_ingestion_state", "内容接入任务没有可执行的提交意图");
  if (!coordinator.registerCancellable(session)) return null;

  const prepared = session.prepared;
  const commit = session.commit;
  const preparedFiles = ingestionPreparedFiles(session, prepared);
  const finalObjectKey = storageObjectKey(session.image_id, prepared.ext);
  let databaseCommitted = false;
  const candidateGuardToken = randomUuidV7();
  try {
    const resolvedTags = await resolveTagNames(commit.metadata.tags);
    const vocabularyLocks = vocabularyAssociationLockRequests([
      ...(commit.metadata.theme
        ? [{ entity: "theme" as const, slug: commit.metadata.theme }]
        : []),
      ...(commit.metadata.author
        ? [{ entity: "author" as const, slug: commit.metadata.author }]
        : []),
      ...resolvedTags.map((slug) => ({ entity: "tag" as const, slug }))
    ]);
    const attempt = await runWithAdvisoryLockAcquisitionSignal(
      signal,
      () => tryWithStorageLocationReadAndAdvisoryLocks(
        [
          ...vocabularyLocks,
          { key: ingestionContentLockKey(prepared.md5) },
          {
            key: `imageshow:ingestion:session:${session.session_id}`,
            acquisition: "try"
          },
          { key: imageStorageMutationLockKey(session.image_id) }
        ],
        async (lockSignal) => {
          const combinedSignal = AbortSignal.any([signal, lockSignal]);
          const storage = resolveStorageAccessForConfig(
            await assertStorageWriteTarget(session.storage_slug)
          );
          const thumbnailKey = thumbnailObjectKey(session.image_id);
          // A guard may own only an absent target or content this frozen
          // commit can adopt. Reject unrelated pre-existing bytes before the
          // guard exists, otherwise its handler could delete those bytes when
          // this commit fails without publishing PostgreSQL truth.
          const [imageTarget, thumbnailTarget] = await verifyCommitTargets([
            {
              storage,
              prefix: "full",
              key: finalObjectKey,
              expected: {
                size: prepared.size,
                sha256: prepared.prepared_image_sha256,
                md5: prepared.md5
              }
            },
            {
              storage,
              prefix: "thumbs",
              key: thumbnailKey,
              expected: {
                size: prepared.thumbnail_size,
                sha256: prepared.prepared_thumbnail_sha256
              }
            }
          ], combinedSignal);
          // Register the exact formal candidates before either write. The job
          // worker takes the same image storage lock, so it cannot observe the
          // guard until this commit has either published PostgreSQL truth or
          // released the lock after failure/cancel. Missing objects are safe;
          // unreferenced created objects therefore always have durable owner.
          const guardedObjects: MoveCleanupObjectInput[] = [imageTarget, thumbnailTarget]
            .map(({ storage: targetStorage, prefix, key }) => ({
              prefix,
              key,
              backend: targetStorage.config.slug
            }));
          if (storage.config.type === "local") {
            guardedObjects.push(...guardedObjects.map((object) => ({
              ...object,
              key: `${object.key}.candidate-${candidateGuardToken}`
            })));
          }
          await enqueueObjectsForCleanup(
            session.image_id,
            guardedObjects,
            "ingestion_commit_candidate_guard",
            { guardToken: candidateGuardToken }
          );
          const reportUpload = async (bytes: number) => {
            await updateIngestionExecutionProgress(repository, session, {
              phase: "uploading",
              message: "写入所选存储并校验完整性",
              progress: Math.min(95, Math.floor(bytes / (prepared.size + prepared.thumbnail_size) * 95))
            });
          };
          await reportUpload(0);
          await withActiveIngestionTempPaths(preparedFiles.map(ingestionPreparedPath), () => withIngestionExecutionHeartbeat(
            repository,
            session,
            combinedSignal,
            async (executionSignal) => {
              executionSignal.throwIfAborted();
              await assertCurrentCommitExecution(repository, session);
              await assertCurrentDuplicateDecision(
                session.image_id,
                prepared,
                commit.duplicate_decision
              );
              await writeVerifiedFileToStorage({
                target: imageTarget,
                sourcePath: ingestionPreparedPath(preparedFiles[0]),
                contentType: contentType(prepared.ext),
                onProgress: (bytes) => reportUpload(bytes),
                sourceMismatch: {
                  status: 409,
                  code: "storage_object_conflict",
                  message: "准备好的图片文件与完整性信息不一致"
                },
                ownedIngestionCandidateGuard: {
                  imageId: session.image_id,
                  token: candidateGuardToken
                },
                signal: executionSignal
              });
              await writeVerifiedFileToStorage({
                target: thumbnailTarget,
                sourcePath: ingestionPreparedPath(preparedFiles[1]),
                contentType: "image/webp",
                onProgress: (bytes) => reportUpload(prepared.size + bytes),
                sourceMismatch: {
                  status: 409,
                  code: "storage_object_conflict",
                  message: "准备好的缩略图与完整性信息不一致"
                },
                ownedIngestionCandidateGuard: {
                  imageId: session.image_id,
                  token: candidateGuardToken
                },
                signal: executionSignal
              });
              executionSignal.throwIfAborted();
            }
          ));

          const persisted = await withImageMutationSync(async (mutationBatch) => {
            const result = await coordinator.beginDatabaseTransaction(
              session,
              async () => {
                combinedSignal.throwIfAborted();
                await assertCurrentCommitExecution(repository, session);
                combinedSignal.throwIfAborted();
              },
              () => {
                combinedSignal.throwIfAborted();
                return persistIngestionImage(session, resolvedTags);
              },
              combinedSignal
            );
            // From this point PostgreSQL is authoritative. Freeze the exact
            // prepared file paths before any cache, receipt, or cleanup await
            // can fail and erase the prepared paths from Redis recovery state.
            databaseCommitted = true;
            if (result.inserted) mutationBatch.add({ id: session.image_id });
            return result;
          });
          // The image is now visible through the authoritative PostgreSQL and
          // ready-image projections. Freeze that boundary before advisory
          // vocabulary refreshes and completed-card presentation add latency;
          // list reads started after this instant already cover the commit.
          const databaseVisibleAt = Date.now();
          // Keep the compound lease through receipt publication: Redis CAS
          // validates the canonical, not PostgreSQL existence or object location.
          // The image lease still excludes purge, migration and candidate cleanup.
          await Promise.all([
            invalidateEntityCountCaches([
              "theme",
              ...(commit.metadata.author ? ["author" as const] : []),
              ...(resolvedTags.length ? ["tag" as const] : [])
            ]),
            refreshEntityVocabularies(persisted.createdEntityKinds)
          ]);
          let completedItem: CompletedIngestionImageDto | undefined;
          try {
            [completedItem] = await ingestionImageItemsWithTags([
              persisted.image
            ]);
          } catch (error) {
            // PostgreSQL is already authoritative. A presentation failure may
            // fall back to the compact terminal event and bounded snapshot.
            logger.warn("ingestion_completed_event_projection_deferred", {
              session_id: session.session_id,
              image_id: session.image_id,
              error: errorMessage(error)
            });
          }
          await publishCompletedReceipt(
            repository,
            session,
            databaseVisibleAt,
            completedItem
          )
            .catch((error) => {
              logger.warn("ingestion_completed_receipt_deferred", {
                session_id: session.session_id,
                image_id: session.image_id,
                error: errorMessage(error)
              });
            });
          return persisted.image;
        }
      )
    );
    return attempt.acquired ? attempt.value : null;
  } finally {
    coordinator.unregisterCancellable(session);
    if (databaseCommitted) {
      try {
        await removeIngestionPreparedFiles(preparedFiles);
      } catch (error) {
        logger.warn("ingestion_prepared_cleanup_deferred", {
          session_id: session.session_id,
          image_id: session.image_id,
          error: errorMessage(error)
        });
        await ingestionCleanupRetryQueue.enqueue(() => removeIngestionPreparedFiles(preparedFiles));
      }
    }
  }
}
