import type { AdminImageListItemDto } from "@imageshow/shared/browser";
import { ApiError, errorMessage } from "../../../core/api-error.ts";
import { runWithAdvisoryLockSignal } from "../../../core/database/advisory-locks.ts";
import { logger } from "../../../core/logger.ts";
import { randomUuidV7 } from "../../../core/uuid.ts";
import { resolveTagNames } from "../../../tags/query.ts";
import {
  invalidateEntityCountCaches,
  refreshEntityVocabularies
} from "../../../vocab/vocab-cache.ts";
import { vocabularyAssociationLockRequests } from "../../../vocab/mutation-sync.ts";
import { resolveStorageAccess } from "../../../storage/backends/registry.ts";
import { thumbnailObjectKey } from "../../../storage/objects/image-paths.ts";
import {
  imageStorageMutationLockKey,
  tryWithStorageLocationReadAndAdvisoryLocks
} from "../../../storage/maintenance-lock.ts";
import { enqueueObjectsForCleanup } from "../../../storage/cleanup/service.ts";
import {
  copyVerifiedObjectWithinStorage
} from "../../../storage/objects/transfer.ts";
import { withImageMutationSync } from "../../mutation-sync.ts";
import { adminImageListItemsWithTags } from "../../presenter.ts";
import { publishCompletedReceipt } from "./completion.ts";
import { ingestionContentLockKey } from "./duplicate-confirmation.ts";
import { persistIngestionImage } from "./persistence.ts";
import { IngestionCommitStagingCleanupPlan } from "./staging-cleanup.ts";
import {
  assertCommitTargetsAvailable,
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
  ) throw new ApiError(409, "invalid_import_state", "内容接入任务没有可执行的提交意图");
  if (!coordinator.registerCancellable(session)) return null;

  const prepared = session.prepared;
  const commit = session.commit;
  const stagingKeys = [
    prepared.prepared_image_key,
    prepared.prepared_thumbnail_key
  ];
  const stagingCleanupPlan = new IngestionCommitStagingCleanupPlan(
    session.storage_slug,
    stagingKeys
  );
  const candidateGuardToken = randomUuidV7();
  try {
    const resolvedTags = await resolveTagNames(commit.metadata.tags);
    const vocabularyLocks = vocabularyAssociationLockRequests([
      ...(commit.metadata.theme && commit.metadata.theme !== "none"
        ? [{ entity: "theme" as const, slug: commit.metadata.theme }]
        : []),
      ...(commit.metadata.author
        ? [{ entity: "author" as const, slug: commit.metadata.author }]
        : []),
      ...resolvedTags.map((slug) => ({ entity: "tag" as const, slug }))
    ]);
    const attempt = await runWithAdvisoryLockSignal(
      signal,
      () => tryWithStorageLocationReadAndAdvisoryLocks(
        [
          ...vocabularyLocks,
          { key: ingestionContentLockKey(prepared.md5) },
          {
            key: `imageshow:import-session:${session.session_id}`,
            acquisition: "try"
          },
          { key: imageStorageMutationLockKey(session.image_id) }
        ],
        async (lockSignal) => {
          const combinedSignal = AbortSignal.any([signal, lockSignal]);
          const storage = await resolveStorageAccess(session.storage_slug);
          const thumbnailKey = thumbnailObjectKey(commit.final_object_key);
          // A guard may own only an absent target or content this frozen
          // commit can adopt. Reject unrelated pre-existing bytes before the
          // guard exists, otherwise its handler could delete those bytes when
          // this commit fails without publishing PostgreSQL truth.
          await assertCommitTargetsAvailable([
            {
              storage,
              prefix: "media",
              key: commit.final_object_key,
              expected: {
                size: prepared.size,
                sha256: prepared.prepared_image_sha256
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
          // Register the exact formal candidates before either copy. The job
          // worker takes the same image storage lock, so it cannot observe the
          // guard until this commit has either published PostgreSQL truth or
          // released the lock after failure/cancel. Missing objects are safe;
          // unreferenced created objects therefore always have durable owner.
          const guardedObjects = [
            {
              prefix: "media" as const,
              key: commit.final_object_key,
              backend: session.storage_slug
            },
            {
              prefix: "thumbs" as const,
              key: thumbnailKey,
              backend: session.storage_slug
            }
          ];
          if (storage.config.type === "local") {
            guardedObjects.push(
              {
                prefix: "media",
                key: `${commit.final_object_key}.candidate-${candidateGuardToken}`,
                backend: session.storage_slug
              },
              {
                prefix: "thumbs",
                key: `${thumbnailKey}.candidate-${candidateGuardToken}`,
                backend: session.storage_slug
              }
            );
          }
          await enqueueObjectsForCleanup(
            session.image_id,
            guardedObjects,
            "import_commit_candidate_guard",
            { guardToken: candidateGuardToken }
          );
          await withIngestionExecutionHeartbeat(
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
              await copyVerifiedObjectWithinStorage({
                storage,
                fromPrefix: "_uploads",
                fromKey: prepared.prepared_image_key,
                toPrefix: "media",
                toKey: commit.final_object_key,
                expectedSource: {
                  size: prepared.size,
                  sha256: prepared.prepared_image_sha256,
                  md5: prepared.md5
                },
                sourceMismatch: {
                  status: 409,
                  code: "storage_object_conflict",
                  message: "准备好的图片文件与完整性信息不一致"
                },
                cleanupCandidate: async () => undefined,
                ownedIngestionCandidateGuard: {
                  imageId: session.image_id,
                  token: candidateGuardToken
                },
                signal: executionSignal
              });
              await copyVerifiedObjectWithinStorage({
                storage,
                fromPrefix: "_uploads",
                fromKey: prepared.prepared_thumbnail_key,
                toPrefix: "thumbs",
                toKey: thumbnailKey,
                expectedSource: {
                  size: prepared.thumbnail_size,
                  sha256: prepared.prepared_thumbnail_sha256
                },
                sourceMismatch: {
                  status: 409,
                  code: "storage_object_conflict",
                  message: "准备好的缩略图与完整性信息不一致"
                },
                cleanupCandidate: async () => undefined,
                ownedIngestionCandidateGuard: {
                  imageId: session.image_id,
                  token: candidateGuardToken
                },
                signal: executionSignal
              });
              executionSignal.throwIfAborted();
            }
          );

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
            // staging cleanup plan before any cache, receipt, or cleanup await
            // can fail and erase the prepared keys from Redis recovery state.
            stagingCleanupPlan.arm();
            if (result.inserted) mutationBatch.add({ id: session.image_id });
            return result;
          });
          // The image is now visible through the authoritative PostgreSQL and
          // ready-image projections. Freeze that boundary before advisory
          // vocabulary refreshes and completed-card presentation add latency;
          // list reads started after this instant already cover the commit.
          const databaseVisibleAt = Date.now();
          await Promise.all([
            invalidateEntityCountCaches([
              "theme",
              ...(commit.metadata.author ? ["author" as const] : []),
              ...(resolvedTags.length ? ["tag" as const] : [])
            ]),
            refreshEntityVocabularies(persisted.createdEntityKinds)
          ]);
          let completedItem: AdminImageListItemDto | undefined;
          try {
            [completedItem] = await adminImageListItemsWithTags([
              persisted.image
            ]);
          } catch (error) {
            // PostgreSQL is already authoritative. A presentation failure may
            // fall back to the compact terminal event and bounded snapshot.
            logger.warn("import_completed_event_projection_deferred", {
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
              logger.warn("import_completed_receipt_deferred", {
                session_id: session.session_id,
                image_id: session.image_id,
                error: errorMessage(error)
              });
            });
          const retainedStagingKeys = await stagingCleanupPlan.removeNow();
          if (retainedStagingKeys) {
            logger.warn("import_staging_cleanup_deferred", {
              session_id: session.session_id,
              image_id: session.image_id,
              keys: retainedStagingKeys
            });
          }
          return persisted.image;
        }
      )
    );
    await stagingCleanupPlan.enqueueRetained();
    return attempt.acquired ? attempt.value : null;
  } catch (error) {
    // Formal media/thumb candidates were guarded persistently before copy.
    // Only disposable staging cleanup remains for the bounded retry queue.
    await stagingCleanupPlan.enqueueRetained();
    throw error;
  } finally {
    coordinator.unregisterCancellable(session);
  }
}
