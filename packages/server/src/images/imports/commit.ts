import { pool } from "../../core/db.ts";
import { ApiError, errorMessage } from "../../core/api-error.ts";
import { logger } from "../../core/logger.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import { resolveTagNames } from "../../tags/query.ts";
import { vocabularyAssociationLockRequests } from "../../vocab/mutation-sync.ts";
import { resolveStorageAccess } from "../../storage/backend-registry.ts";
import { storageObjectKey, thumbnailObjectKey } from "../../storage/image-paths.ts";
import {
  imageStorageMutationLockKey,
  tryWithStorageLocationReadAndAdvisoryLocks
} from "../../storage/maintenance-lock.ts";
import { copyVerifiedObjectWithinStorage } from "../../storage/object-transfer.ts";
import {
  removeStorageObjectAndConfirm
} from "../../storage/object-access.ts";
import { resolveClassification } from "../classification.ts";
import { importCommitImage } from "../presenter.ts";
import {
  cleanupImportCandidate,
  cleanupImportCandidatesIfUnreferenced,
  importCandidateIsPublishedOrRecoverable,
  type ImportCandidateObject
} from "./commit-candidates.ts";
import {
  persistCommittedImage,
  readCommittedImage
} from "./commit-persistence.ts";
import { synchronizeCommittedImport } from "./commit-sync.ts";
import { withImportLease } from "./lifecycle.ts";
import { notifyImportStatus } from "./status.ts";
import {
  runImportCommit,
  runImportCommitWithinByteBudget
} from "./execution.ts";
import { importSessionLockKey } from "./session-lock.ts";
import type {
  ImportMetadata,
  ImportSessionRow,
  MetadataPayload,
  PreparedPayload
} from "./types.ts";

type CommitImportSessionRecord = Pick<
  ImportSessionRow,
  | "status"
  | "storage_slug"
  | "final_object_key"
  | "prepared_payload"
  | "image_time"
  | "execution_token"
>;

async function assertPreparedObjectExists(
  storage: Awaited<ReturnType<typeof resolveStorageAccess>>,
  key: string,
  errorCode: "prepared_object_missing" | "prepared_thumbnail_missing",
  errorMessage: string
) {
  if (!await storage.driver.exists("_uploads", key)) {
    throw new ApiError(409, errorCode, errorMessage);
  }
}

async function commitStoredImageSession(
  id: string,
  session: CommitImportSessionRecord,
  payload: PreparedPayload,
  executionToken: string,
  resolvedTags: string[],
  signal: AbortSignal
) {
  const backend = session.storage_slug;
  const finalKey = session.final_object_key;
  const thumbKey = thumbnailObjectKey(finalKey);
  let copiedImage = false;
  let copiedThumbnail = false;
  let databaseCommitted = false;

  try {
    signal.throwIfAborted();
    const storage = await resolveStorageAccess(backend);
    const preparedImageKey = payload.prepared_image_key;
    signal.throwIfAborted();
    await assertPreparedObjectExists(
      storage,
      preparedImageKey,
      "prepared_object_missing",
      "准备好的图片文件不存在"
    );
    await assertPreparedObjectExists(
      storage,
      payload.prepared_thumbnail_key,
      "prepared_thumbnail_missing",
      "准备好的缩略图不存在"
    );
    signal.throwIfAborted();
    copiedImage = (await copyVerifiedObjectWithinStorage({
      storage,
      fromPrefix: "_uploads",
      fromKey: preparedImageKey,
      toPrefix: "media",
      toKey: finalKey,
      expectedSource: {
        size: payload.size,
        sha256: payload.prepared_image_sha256,
        md5: payload.md5
      },
      sourceMismatch: {
        status: 409,
        code: "storage_object_conflict",
        message: "准备好的图片文件与已记录的完整性信息不一致"
      },
      cleanupCandidate: cleanupImportCandidate(
        id,
        backend,
        finalKey,
        executionToken,
        signal,
        "import_media_integrity_failure"
      )
    })).created;
    signal.throwIfAborted();
    copiedThumbnail = (await copyVerifiedObjectWithinStorage({
      storage,
      fromPrefix: "_uploads",
      fromKey: payload.prepared_thumbnail_key,
      toPrefix: "thumbs",
      toKey: thumbKey,
      expectedSource: {
        size: payload.thumbnail_size,
        sha256: payload.prepared_thumbnail_sha256
      },
      sourceMismatch: {
        status: 409,
        code: "storage_object_conflict",
        message: "准备好的缩略图与已记录的完整性信息不一致"
      },
      cleanupCandidate: cleanupImportCandidate(
        id,
        backend,
        finalKey,
        executionToken,
        signal,
        "import_thumbnail_integrity_failure"
      )
    })).created;
    signal.throwIfAborted();

    const result = await persistCommittedImage(
      id,
      session,
      payload,
      executionToken,
      resolvedTags,
      signal
    );
    databaseCommitted = true;

    const stagingCleanup = await Promise.allSettled([
      removeStorageObjectAndConfirm(
        "_uploads",
        payload.prepared_image_key,
        backend
      ),
      removeStorageObjectAndConfirm(
        "_uploads",
        payload.prepared_thumbnail_key,
        backend
      )
    ]);
    for (const [index, cleanup] of stagingCleanup.entries()) {
      if (cleanup.status === "fulfilled") continue;
      logger.warn("import_staging_cleanup_deferred", {
        import_id: id,
        backend,
        key: index === 0
          ? payload.prepared_image_key
          : payload.prepared_thumbnail_key,
        error: errorMessage(cleanup.reason)
      });
    }
    const image = await synchronizeCommittedImport(
      id,
      payload,
      result.createdEntityKinds
    );
    return { status: "imported" as const, item: await importCommitImage(image) };
  } catch (error) {
    if (!databaseCommitted) {
      const candidates: ImportCandidateObject[] = [
        ...(copiedImage
          ? [{ prefix: "media" as const, key: finalKey, backend }]
          : []),
        ...(copiedThumbnail
          ? [{ prefix: "thumbs" as const, key: thumbKey, backend }]
          : [])
      ];
      try {
        await cleanupImportCandidatesIfUnreferenced(
          id,
          candidates,
          "import_commit_rollback",
          () => importCandidateIsPublishedOrRecoverable(
            id,
            backend,
            finalKey,
            executionToken,
            signal
          )
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Import commit failed and candidate cleanup could not be queued"
        );
      }
    }
    throw error;
  }
}

async function commitImportSessionWhileLocationStable(
  id: string,
  metadata: ImportMetadata,
  resolvedTags: string[],
  signal: AbortSignal
) {
  signal.throwIfAborted();
  let session = (await pool.query(
      `SELECT status, storage_slug, final_object_key, prepared_payload,
              image_time, execution_token
         FROM import_session
        WHERE id=$1`,
      [id]
  )).rows[0] as CommitImportSessionRecord | undefined;
  if (!session) throw new ApiError(404, "not_found", "导入任务不存在");
  if (session.status === "finalized") {
    const image = await readCommittedImage(id);
    if (!image) return { status: "duplicate" as const };
    const current = await synchronizeCommittedImport(
      image.id,
      session.prepared_payload as PreparedPayload
    );
    return { status: "imported" as const, item: await importCommitImage(current) };
  }
  if (!["ready", "committing"].includes(session.status)) {
    throw new ApiError(409, "invalid_import_state", "图片尚未准备完成");
  }

  return withImportLease(id, async () => {
    signal.throwIfAborted();
    const executionToken = randomUuidV7();
    if (session?.status === "ready") {
      const payload = { ...session.prepared_payload, ...metadata } as PreparedPayload;
      const metadataPayload: MetadataPayload = {
        ...metadata,
        image_time: new Date(session.image_time).toISOString()
      };
      const classification = resolveClassification(metadata, {
        device: payload.detected_device,
        brightness: payload.detected_brightness
      });
      const finalKey = storageObjectKey(
        classification.device,
        classification.brightness,
        metadata.theme,
        id,
        payload.ext
      );
      signal.throwIfAborted();
      const claimed = await pool.query(
        `UPDATE import_session
         SET status='committing', metadata_payload=$2::jsonb, prepared_payload=$3::jsonb,
             final_object_key=$4, execution_token=$5::uuid, updated_at=now()
         WHERE id=$1 AND status='ready'
         RETURNING status, storage_slug, final_object_key, prepared_payload,
                   image_time, execution_token`,
        [
          id,
          JSON.stringify(metadataPayload),
          JSON.stringify(payload),
          finalKey,
          executionToken
        ]
      );
      if (!claimed.rowCount) {
        throw new ApiError(
          409,
          "import_already_finalizing",
          "Import is already being committed"
        );
      }
      session = claimed.rows[0] as CommitImportSessionRecord;
      await notifyImportStatus(id).catch(() => undefined);
    } else if (session?.status === "committing") {
      const reclaimed = await pool.query(
        `UPDATE import_session
            SET execution_token=$2::uuid, updated_at=now()
          WHERE id=$1 AND status='committing'
          RETURNING status, storage_slug, final_object_key, prepared_payload,
                    image_time, execution_token`,
        [id, executionToken]
      );
      if (!reclaimed.rowCount) {
        throw new ApiError(
          409,
          "import_already_finalizing",
          "Import commit execution ownership changed"
        );
      }
      session = reclaimed.rows[0] as CommitImportSessionRecord;
    }

    if (!session) throw new ApiError(404, "not_found", "导入任务不存在");
    const currentSession = session;
    const payload = currentSession.prepared_payload as PreparedPayload;
    const result = await commitStoredImageSession(
      id,
      currentSession,
      payload,
      executionToken,
      resolvedTags,
      signal
    );
    await notifyImportStatus(id).catch(() => undefined);
    return result;
  });
}

async function importCommitVocabularyLocks(
  id: string,
  metadata: ImportMetadata
) {
  const row = (await pool.query(
    "SELECT status, prepared_payload FROM import_session WHERE id=$1",
    [id]
  )).rows[0] as Pick<
    ImportSessionRow,
    "status" | "prepared_payload"
  > | undefined;
  const prepared = row?.prepared_payload as Partial<PreparedPayload> | undefined;
  const finalPayload = row?.status === "ready"
    ? { ...prepared, ...metadata }
    : prepared ?? metadata;
  const resolvedTags = await resolveTagNames(finalPayload.tags ?? []);
  const entries = [
    ...(finalPayload.theme && finalPayload.theme !== "none"
      ? [{ entity: "theme" as const, slug: finalPayload.theme }]
      : []),
    ...(finalPayload.author
      ? [{ entity: "author" as const, slug: finalPayload.author }]
      : []),
    ...resolvedTags.map((slug) => ({ entity: "tag" as const, slug }))
  ];
  return {
    locks: vocabularyAssociationLockRequests(entries),
    resolvedTags
  };
}

async function commitImportSessionWithinLimit(
  id: string,
  metadata: ImportMetadata,
  commitSignal: AbortSignal
) {
  const vocabulary = await importCommitVocabularyLocks(id, metadata);
  const attempt = await tryWithStorageLocationReadAndAdvisoryLocks(
    [
      ...vocabulary.locks,
      { key: importSessionLockKey(id), acquisition: "try" },
      { key: imageStorageMutationLockKey(id) }
    ],
    (lockSignal) => commitImportSessionWhileLocationStable(
      id,
      metadata,
      vocabulary.resolvedTags,
      AbortSignal.any([commitSignal, lockSignal])
    )
  );
  if (!attempt.acquired) {
    throw new ApiError(409, "import_already_finalizing", "Import is already being committed");
  }
  return attempt.value;
}

async function importCommitByteWeight(id: string) {
  const row = (await pool.query(
    "SELECT prepared_payload FROM import_session WHERE id=$1",
    [id]
  )).rows[0] as Pick<ImportSessionRow, "prepared_payload"> | undefined;
  if (!row) return 1;
  const payload = row.prepared_payload as Partial<PreparedPayload>;
  const imageBytes = Number(payload.size ?? 0);
  const thumbnailBytes = Number(payload.thumbnail_size ?? 0);
  const total = imageBytes + thumbnailBytes;
  return Number.isFinite(total) ? Math.max(1, total) : 1;
}

export function commitImportSession(id: string, metadata: ImportMetadata, signal?: AbortSignal) {
  const commitSignal = signal ?? new AbortController().signal;
  return runImportCommit(async () => {
    const bytes = await importCommitByteWeight(id);
    return runImportCommitWithinByteBudget(
      bytes,
      () => commitImportSessionWithinLimit(id, metadata, commitSignal),
      commitSignal
    );
  }, commitSignal);
}
