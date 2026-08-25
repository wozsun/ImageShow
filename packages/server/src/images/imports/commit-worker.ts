import type { AdminImageListItemDto } from "@imageshow/shared/browser";
import { ApiError, errorMessage } from "../../core/api-error.ts";
import { runWithAdvisoryLockSignal } from "../../core/database-advisory-locks.ts";
import { withTransaction } from "../../core/database-transactions.ts";
import { logger } from "../../core/logger.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import { ensureAuthorWithMutationLockHeld } from "../../authors/mutations.ts";
import { replaceImageTags } from "../../tags/mutations.ts";
import { resolveTagNames } from "../../tags/query.ts";
import { ensureThemeWithMutationLockHeld } from "../../themes/mutations.ts";
import {
  invalidateEntityCountCaches,
  refreshEntityVocabularies,
  type EntityCacheKind
} from "../../vocab/vocab-cache.ts";
import { vocabularyAssociationLockRequests } from "../../vocab/mutation-sync.ts";
import { resolveStorageAccess } from "../../storage/backend-registry.ts";
import { thumbnailObjectKey } from "../../storage/image-paths.ts";
import {
  imageStorageMutationLockKey,
  tryWithStorageLocationReadAndAdvisoryLocks,
  withStorageLocationReadLock
} from "../../storage/maintenance-lock.ts";
import { enqueueObjectsForCleanup } from "../../storage/move-cleanup.ts";
import {
  removeStorageObjectAndConfirm
} from "../../storage/object-access.ts";
import {
  assertStorageTargetAvailable,
  copyVerifiedObjectWithinStorage
} from "../../storage/object-transfer.ts";
import { resolveClassification } from "../classification.ts";
import { withImageMutationSync } from "../mutation-sync.ts";
import {
  adminImageListItemsWithTags,
  adminImageListPresentationColumns,
  adminImageListPresentationColumnsWithTags,
  type ImageRecord,
  type ImageRecordWithTags
} from "../presenter.ts";
import { readDuplicateSnapshotByMd5 } from "../read-models/duplicates.ts";
import { importContentLockKey } from "./duplicate-confirmation.ts";
import { importRetiredCleanupQueue } from "./cleanup-queue.ts";
import { withImportExecutionHeartbeat } from "./execution-heartbeat.ts";
import { ImportIrreversibleCoordinator } from "./irreversible-coordinator.ts";
import { importSessionLockKey } from "./session-lock.ts";
import {
  completedImportDisplay,
  type CompletedImportReceipt,
  type ImportPreparedManifest,
  type ImportSessionSnapshot
} from "./session-model.ts";
import { ImportSessionRepository } from "./session-repository.ts";

async function removeCommittedStagingKeys(
  storageSlug: string,
  keys: readonly string[]
) {
  await withStorageLocationReadLock(async (signal) => {
    const removals = await Promise.allSettled(keys.map((key) => (
      removeStorageObjectAndConfirm("_uploads", key, storageSlug, { signal })
    )));
    const failures = removals.flatMap((result) => (
      result.status === "rejected" ? [result.reason] : []
    ));
    if (failures.length) {
      throw new AggregateError(failures, "Committed import staging cleanup failed");
    }
  });
}

type ImportCommitStagingCleanupPlanDependencies = {
  removeImmediately?: (key: string) => Promise<void>;
  removeRetained?: (keys: readonly string[]) => Promise<void>;
  schedule?: (work: () => Promise<void>) => Promise<void>;
};

/**
 * Retains the exact prepared-object paths from the PostgreSQL boundary until
 * direct removal succeeds or the bounded retry queue accepts ownership.
 */
class ImportCommitStagingCleanupPlan {
  readonly #keys: readonly string[];
  readonly #removeImmediately: (key: string) => Promise<void>;
  readonly #removeRetained: (keys: readonly string[]) => Promise<void>;
  readonly #schedule: (work: () => Promise<void>) => Promise<void>;
  #pendingKeys: string[] = [];
  #scheduled = false;

  constructor(
    storageSlug: string,
    keys: readonly string[],
    dependencies: ImportCommitStagingCleanupPlanDependencies = {}
  ) {
    this.#keys = [...keys];
    this.#removeImmediately = dependencies.removeImmediately
      ?? (async (key) => {
        await removeStorageObjectAndConfirm("_uploads", key, storageSlug);
      });
    this.#removeRetained = dependencies.removeRetained
      ?? ((retainedKeys) => removeCommittedStagingKeys(storageSlug, retainedKeys));
    this.#schedule = dependencies.schedule
      ?? ((work) => importRetiredCleanupQueue.enqueue(work));
  }

  arm() {
    this.#pendingKeys = [...this.#keys];
  }

  async removeNow() {
    const keys = [...this.#pendingKeys];
    const removals = await Promise.allSettled(keys.map(this.#removeImmediately));
    this.#pendingKeys = removals.flatMap((result, index) => (
      result.status === "rejected" ? [keys[index]!] : []
    ));
    return this.#pendingKeys.length;
  }

  async enqueueRetained() {
    if (!this.#pendingKeys.length || this.#scheduled) return;
    const retainedKeys = [...this.#pendingKeys];
    await this.#schedule(() => this.#removeRetained(retainedKeys));
    this.#scheduled = true;
  }
}

type CommitTargetAvailability = Omit<
  Parameters<typeof assertStorageTargetAvailable>[0],
  "signal"
>;

/** Cancel and drain sibling digests before releasing the storage lock. */
async function assertCommitTargetsAvailable(
  targets: readonly CommitTargetAvailability[],
  signal: AbortSignal
) {
  const siblingAbort = new AbortController();
  const checkSignal = AbortSignal.any([signal, siblingAbort.signal]);
  let failed = false;
  let firstFailure: unknown;
  const checks = targets.map(async (target) => {
    try {
      await assertStorageTargetAvailable({
        ...target,
        signal: checkSignal
      });
    } catch (error) {
      if (!failed) {
        failed = true;
        firstFailure = error;
        siblingAbort.abort(error);
      }
      throw error;
    }
  });
  await Promise.allSettled(checks);
  signal.throwIfAborted();
  if (failed) throw firstFailure;
}

async function assertCurrentCommitExecution(
  repository: ImportSessionRepository,
  expected: ImportSessionSnapshot
) {
  const current = await repository.readSession(
    expected.owner,
    expected.session_id
  );
  if (
    !current
    || !("execution_token" in current)
    || current.image_id !== expected.image_id
    || current.status !== "committing"
    || current.version !== expected.version
    || current.execution_token !== expected.execution_token
  ) {
    throw new ApiError(409, "import_execution_fenced", "导入提交执行权已转移");
  }
}

async function assertCurrentDuplicateDecision(
  imageId: string,
  prepared: ImportPreparedManifest,
  decision: "upload" | "confirmed"
) {
  const duplicates = (await readDuplicateSnapshotByMd5(prepared.md5)).items
    .filter((item) => item.id.toLowerCase() !== imageId.toLowerCase());
  if (duplicates.length && decision !== "confirmed") {
    throw new ApiError(
      409,
      "import_duplicate_conflict",
      "提交前发现相同内容图片，请确认是否仍然提交",
      { duplicates }
    );
  }
}

async function persistImportImage(
  session: ImportSessionSnapshot,
  resolvedTags: string[]
) {
  const prepared = session.prepared!;
  const commit = session.commit!;
  return withTransaction(async (client) => {
    const existing = (await client.query<
      ImageRecordWithTags & { created_by: string }
    >(
      `SELECT ${adminImageListPresentationColumnsWithTags}, created_by
         FROM metadata
        WHERE id=$1`,
      [session.image_id]
    )).rows[0];
    if (existing) {
      if (existing.created_by !== commit.created_by) {
        throw new ApiError(
          409,
          "import_image_owner_conflict",
          "图片 ID 已属于其他管理员"
        );
      }
      return {
        inserted: false,
        image: existing,
        createdEntityKinds: new Set<EntityCacheKind>()
      };
    }

    const createdEntityKinds = new Set<EntityCacheKind>();
    if (await ensureThemeWithMutationLockHeld(client, commit.metadata.theme)) {
      createdEntityKinds.add("theme");
    }
    if (await ensureAuthorWithMutationLockHeld(client, commit.metadata.author)) {
      createdEntityKinds.add("author");
    }
    const classification = resolveClassification(commit.metadata, {
      device: prepared.detected_device,
      brightness: prepared.detected_brightness
    });
    const inserted = await client.query<ImageRecord>(
      `INSERT INTO metadata(
         id, image_time, device, brightness, theme, width, height, image_size,
         ext, object_key, storage_slug, title, description, source, original,
         md5, thumbnail_size, author, created_by
       )
       VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
       )
       RETURNING ${adminImageListPresentationColumns}`,
      [
        session.image_id,
        session.image_time,
        classification.device,
        classification.brightness,
        commit.metadata.theme,
        prepared.width,
        prepared.height,
        prepared.size,
        prepared.ext,
        commit.final_object_key,
        session.storage_slug,
        commit.metadata.title,
        commit.metadata.description,
        commit.metadata.source,
        commit.metadata.original,
        prepared.md5,
        prepared.thumbnail_size,
        commit.metadata.author || null,
        commit.created_by
      ]
    );
    if ((await replaceImageTags(
      client,
      session.image_id,
      resolvedTags,
      new AbortController().signal
    )).createdTag) {
      createdEntityKinds.add("tag");
    }
    return {
      inserted: true,
      image: {
        ...inserted.rows[0]!,
        tags: resolvedTags
      },
      createdEntityKinds
    };
  });
}

export async function publishCompletedReceipt(
  repository: ImportSessionRepository,
  session: ImportSessionSnapshot,
  completedAt: number,
  completedItem?: AdminImageListItemDto
) {
  const current = await repository.readSession(session.owner, session.session_id);
  if (!current || current.image_id !== session.image_id) return;
  if (current.status === "completed") return;
  if (current.status === "discarded") return;
  if (current.status !== "committing" && current.status !== "resolving") return;
  if (!("commit" in current) || !current.commit) return;
  const receipt = completedImportReceipt(current, completedAt);
  await repository.mutateSemantic(
    current,
    current.version,
    receipt,
    Date.now(),
    { completedItem }
  );
}

export function completedImportReceipt(
  session: ImportSessionSnapshot,
  completedAt: number
): CompletedImportReceipt {
  if (!session.commit) {
    throw new ApiError(
      409,
      "import_commit_intent_missing",
      "导入任务缺少已冻结的提交意图"
    );
  }
  const display = completedImportDisplay(session);
  return {
    owner: session.owner,
    queue: session.queue,
    session_id: session.session_id,
    image_id: session.image_id,
    request_hash: session.request_hash,
    commit_request_id: session.commit.commit_request_id,
    commit_intent_hash: session.commit.commit_intent_hash,
    status: "completed",
    version: session.version,
    last_semantic_revision: session.last_semantic_revision,
    accepted_at: session.accepted_at,
    accepted_order: session.accepted_order,
    completed_at: completedAt,
    ...(display ? { display } : {}),
    discard_at: session.discard_at
  };
}

export async function commitImportSessionSnapshot(
  repository: ImportSessionRepository,
  coordinator: ImportIrreversibleCoordinator,
  session: ImportSessionSnapshot,
  signal: AbortSignal
) {
  if (
    session.status !== "committing"
    || !session.execution_token
    || !session.prepared
    || !session.commit
  ) throw new ApiError(409, "invalid_import_state", "导入任务没有可执行的提交意图");
  if (!coordinator.registerCancellable(session)) return null;

  const prepared = session.prepared;
  const commit = session.commit;
  const stagingKeys = [
    prepared.prepared_image_key,
    prepared.prepared_thumbnail_key
  ];
  const stagingCleanupPlan = new ImportCommitStagingCleanupPlan(
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
          { key: importContentLockKey(prepared.md5) },
          { key: importSessionLockKey(session.session_id), acquisition: "try" },
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
          await withImportExecutionHeartbeat(
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
                ownedImportCandidateGuard: {
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
                ownedImportCandidateGuard: {
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
                return persistImportImage(session, resolvedTags);
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
