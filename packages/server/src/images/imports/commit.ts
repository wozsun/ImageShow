import { ensureAuthorWithMutationLockHeld } from "../../authors/service.ts";
import { pool, withTransaction } from "../../core/db.ts";
import { ApiError, errorMessage } from "../../core/api-error.ts";
import { logger } from "../../core/logger.ts";
import { syncRandomImage } from "../../random/random-cache.ts";
import { ensureThemeWithMutationLockHeld } from "../../themes/service.ts";
import { resolveTagNames } from "../../tags/query.ts";
import { replaceImageTags } from "../../tags/service.ts";
import {
  invalidateEntityCountCaches,
  refreshEntityVocabularies,
  type EntityCacheKind,
} from "../../vocab/vocab-cache.ts";
import { vocabularyMutationLockRequests } from "../../vocab/mutation-sync.ts";
import { resolveStorageAccess } from "../../storage/backend-registry.ts";
import { storageObjectKey, thumbnailObjectKey } from "../../storage/image-paths.ts";
import {
  imageStorageMutationLockKey,
  tryWithStorageLocationReadAndAdvisoryLocks
} from "../../storage/maintenance-lock.ts";
import { copyVerifiedObjectWithinStorage } from "../../storage/object-transfer.ts";
import { removeObjectsOrEnqueueCleanup } from "../../storage/move-cleanup.ts";
import { removeObject } from "../../storage/storage.ts";
import {
  invalidateImageCaches,
  warmCompleteImageLookups
} from "../image-cache.ts";
import { resolveClassification } from "../classification.ts";
import { importCommitImage, type ImageRecord } from "../presenter.ts";
import { notifyImportStatus, withImportLease } from "./progress.ts";
import {
  runImportCommit,
  runImportCommitWithinByteBudget
} from "./execution.ts";
import { importSessionLockKey } from "./session-lock.ts";
import { stagingImageKey } from "./staging.ts";
import type {
  ImportMetadata,
  ImportSessionRow,
  MetadataPayload,
  PreparedPayload
} from "./types.ts";

type CommittedImageRecord = Pick<
  ImageRecord,
  | "id"
  | "author"
  | "object_key"
  | "original"
  | "ext"
  | "storage_slug"
  | "device"
  | "brightness"
  | "theme"
  | "status"
  | "description"
  | "source"
>;

type CommitImportSessionRecord = Pick<
  ImportSessionRow,
  | "status"
  | "storage_slug"
  | "final_object_key"
  | "prepared_payload"
  | "image_time"
>;

type ImportCandidateObject = {
  prefix: "media" | "thumbs" | "_uploads";
  key: string;
  backend: string;
};

const committedImageColumns = [
  "id",
  "author",
  "object_key",
  "original",
  "ext",
  "storage_slug",
  "device",
  "brightness",
  "theme",
  "status",
  "description",
  "source"
].join(", ");

async function finishImport(
  imageId: string,
  payload: PreparedPayload,
  createdEntityKinds: Iterable<EntityCacheKind> = [],
) {
  const image = (await pool.query(
    `SELECT ${committedImageColumns} FROM metadata WHERE id=$1`,
    [imageId]
  )).rows[0] as CommittedImageRecord | undefined;
  if (!image) {
    throw new ApiError(
      409,
      "committed_image_missing",
      "导入已提交，但图片记录不存在"
    );
  }

  await syncRandomImage(image.id);
  const [cacheRevision] = await Promise.all([
    invalidateImageCaches({
      lookupEntries: [{ id: image.id, object_key: image.object_key }],
      md5s: [payload.md5]
    }),
    invalidateEntityCountCaches([
      "theme",
      ...(image.author ? ["author" as const] : []),
      ...((payload.tags?.length ?? 0) ? ["tag" as const] : []),
    ]),
    refreshEntityVocabularies(createdEntityKinds),
  ]);
  await warmCompleteImageLookups([{
    ...image,
    original: image.original ?? null,
    description: image.description ?? null,
    source: image.source ?? null
  }], cacheRevision);
  return image;
}

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

function cleanupImportCandidate(imageId: string, reason: string) {
  return (object: ImportCandidateObject) =>
    removeObjectsOrEnqueueCleanup(imageId, [object], reason);
}

async function cleanupImportCandidatesIfUnreferenced(
  imageId: string,
  candidates: ImportCandidateObject[],
  reason: string,
  isReferenced: () => Promise<boolean>
) {
  if (!candidates.length) return;

  try {
    if (await isReferenced()) return;
  } catch (error) {
    logger.error("import_candidate_ownership_unknown", {
      image_id: imageId,
      reason,
      error: errorMessage(error),
      candidates
    });
    return;
  }

  try {
    await removeObjectsOrEnqueueCleanup(imageId, candidates, reason);
  } catch (error) {
    logger.error("import_candidate_cleanup_failed", {
      image_id: imageId,
      reason,
      error: errorMessage(error),
      candidates
    });
  }
}

async function commitStoredImageSession(
  id: string,
  session: CommitImportSessionRecord,
  payload: PreparedPayload
) {
  const backend = session.storage_slug;
  const finalKey = session.final_object_key;
  const thumbKey = thumbnailObjectKey(finalKey);
  let copiedImage = false;
  let copiedThumbnail = false;
  let databaseCommitted = false;

  try {
    const resolvedTags = await resolveTagNames(payload.tags ?? []);
    const storage = await resolveStorageAccess(backend);
    const preparedImageKey = stagingImageKey(id);
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
        "import_media_integrity_failure"
      )
    })).created;
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
        "import_thumbnail_integrity_failure"
      )
    })).created;

    const classification = resolveClassification(payload, {
      device: payload.detected_device,
      brightness: payload.detected_brightness
    });
    const result = await withTransaction(async (client) => {
      const createdEntityKinds = new Set<EntityCacheKind>();
      if (await ensureThemeWithMutationLockHeld(client, payload.theme)) {
        createdEntityKinds.add("theme");
      }
      if (await ensureAuthorWithMutationLockHeld(client, payload.author)) {
        createdEntityKinds.add("author");
      }
      const insertedRow = await client.query(
        `INSERT INTO metadata(id, image_time, device, brightness, theme, width, height, image_size, ext,
         object_key, storage_slug, title, description, source, original, md5, thumbnail_size, author)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (id) DO NOTHING RETURNING ${committedImageColumns}`,
        [
          id,
          session.image_time,
          classification.device,
          classification.brightness,
          payload.theme,
          payload.width,
          payload.height,
          payload.size,
          payload.ext,
          finalKey,
          backend,
          payload.title,
          payload.description,
          payload.source,
          payload.original,
          payload.md5,
          payload.thumbnail_size,
          payload.author || null
        ]
      );
      const image = (insertedRow.rowCount
        ? insertedRow.rows[0]
        : (await client.query(
            `SELECT ${committedImageColumns} FROM metadata WHERE id=$1`,
            [id]
          )).rows[0]
      ) as CommittedImageRecord;
      if ((await replaceImageTags(client, image.id, resolvedTags)).createdTag) createdEntityKinds.add("tag");
      const finalized = await client.query(
        "UPDATE import_session SET status='finalized', updated_at=now() WHERE id=$1 AND status='committing'",
        [id]
      );
      if (!finalized.rowCount) {
        throw new ApiError(409, "invalid_import_state", "导入任务提交状态已变化");
      }
      return { image, createdEntityKinds };
    });
    databaseCommitted = true;

    await Promise.all([
      removeObject("_uploads", stagingImageKey(id), backend).catch(() => undefined),
      removeObject("_uploads", payload.prepared_thumbnail_key, backend).catch(() => undefined)
    ]);
    const image = await finishImport(id, payload, result.createdEntityKinds);
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
      await cleanupImportCandidatesIfUnreferenced(
        id,
        candidates,
        "import_commit_rollback",
        async () => Boolean((await pool.query(
          `SELECT 1
             FROM metadata
            WHERE id=$1
              AND storage_slug=$2
              AND object_key=$3`,
          [id, backend, finalKey]
        )).rowCount)
      );
    }
    throw error;
  }
}

async function commitImportSessionWhileLocationStable(
  id: string,
  metadata: ImportMetadata
) {
  let session = (await pool.query(
      `SELECT status, storage_slug, final_object_key, prepared_payload, image_time
         FROM import_session
        WHERE id=$1`,
      [id]
  )).rows[0] as CommitImportSessionRecord | undefined;
  if (!session) throw new ApiError(404, "not_found", "导入任务不存在");
  if (session.status === "finalized") {
    const image = (await pool.query(
      `SELECT ${committedImageColumns} FROM metadata WHERE id=$1`,
      [id]
    )).rows[0] as CommittedImageRecord | undefined;
    if (!image) return { status: "duplicate" as const };
    const current = await finishImport(
      image.id,
      session.prepared_payload as PreparedPayload
    );
    return { status: "imported" as const, item: await importCommitImage(current) };
  }
  if (!["ready", "committing"].includes(session.status)) {
    throw new ApiError(409, "invalid_import_state", "图片尚未准备完成");
  }

  return withImportLease(id, async () => {
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
      const claimed = await pool.query(
        `UPDATE import_session
         SET status='committing', metadata_payload=$2::jsonb, prepared_payload=$3::jsonb,
             final_object_key=$4, updated_at=now()
         WHERE id=$1 AND status='ready'
         RETURNING status, storage_slug, final_object_key, prepared_payload, image_time`,
        [
          id,
          JSON.stringify(metadataPayload),
          JSON.stringify(payload),
          finalKey
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
    }

    if (!session) throw new ApiError(404, "not_found", "导入任务不存在");
    const currentSession = session;
    const payload = currentSession.prepared_payload as PreparedPayload;
    const result = await commitStoredImageSession(id, currentSession, payload);
    await notifyImportStatus(id).catch(() => undefined);
    return result;
  });
}

async function importCommitVocabularyLocks(
  id: string,
  metadata: ImportMetadata
) {
  const row = (await pool.query(
    "SELECT prepared_payload FROM import_session WHERE id=$1",
    [id]
  )).rows[0] as Pick<ImportSessionRow, "prepared_payload"> | undefined;
  const prepared = row?.prepared_payload as Partial<PreparedPayload> | undefined;
  const themes = [metadata.theme, prepared?.theme]
    .filter((slug): slug is string => Boolean(slug && slug !== "none"));
  const authors = [metadata.author, prepared?.author]
    .filter((slug): slug is string => Boolean(slug));
  return vocabularyMutationLockRequests([
    ...themes.map((slug) => ({ entity: "theme" as const, slug })),
    ...authors.map((slug) => ({ entity: "author" as const, slug }))
  ]);
}

async function commitImportSessionWithinLimit(id: string, metadata: ImportMetadata) {
  const vocabularyLocks = await importCommitVocabularyLocks(id, metadata);
  const attempt = await tryWithStorageLocationReadAndAdvisoryLocks(
    [
      ...vocabularyLocks,
      { key: importSessionLockKey(id), acquisition: "try" },
      { key: imageStorageMutationLockKey(id) }
    ],
    () => commitImportSessionWhileLocationStable(id, metadata)
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
      () => commitImportSessionWithinLimit(id, metadata),
      commitSignal
    );
  }, commitSignal);
}
