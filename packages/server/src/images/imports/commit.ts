import { ensureAuthor } from "../../authors/service.ts";
import { pool, withTransaction } from "../../core/db.ts";
import { ApiError } from "../../core/http.ts";
import { syncRandomImage } from "../../random/random-cache.ts";
import { ensureTheme } from "../../themes/service.ts";
import { resolveTagNames } from "../../tags/query.ts";
import { replaceImageTags } from "../../tags/service.ts";
import { invalidateTagVocab } from "../../vocab/vocab-cache.ts";
import { linkThumbnailKey, storageObjectKey, thumbnailObjectKey } from "../../storage/image-paths.ts";
import { withStorageMutationLock } from "../../storage/maintenance-lock.ts";
import { copyObject, exists, removeObject } from "../../storage/storage.ts";
import {
  invalidateImageReadCaches,
  invalidateMd5Cache,
  setImageLookup,
  setImageLookupById
} from "../image-cache.ts";
import { resolveClassification } from "../classification.ts";
import { publicImage, type ImageRecord } from "../presenter.ts";
import { notifyImportStatus, withImportLease } from "./progress.ts";
import { stagingImageKey } from "./staging.ts";
import type {
  ImportMetadata,
  ImportSessionRow,
  MetadataPayload,
  PreparedPayload
} from "./types.ts";

async function finishImport(image: ImageRecord, payload: PreparedPayload) {
  if (payload.tags?.length) await invalidateTagVocab();
  await syncRandomImage(image.id);
  await invalidateMd5Cache(payload.md5);
  await invalidateImageReadCaches();
  await setImageLookupById({
    id: image.id,
    object_key: image.object_key,
    original: image.original ?? "",
    ext: image.ext,
    storage_slug: image.storage_slug,
    is_link: Boolean(image.is_link),
    device: image.device,
    brightness: image.brightness,
    theme: image.theme,
    status: image.status
  });
  if (!image.is_link) {
    await setImageLookup({
      object_key: image.object_key,
      thumb_key: thumbnailObjectKey(image.object_key),
      ext: image.ext,
      storage_slug: image.storage_slug,
      status: "ready"
    });
  }
}

async function commitStoredImageSession(
  id: string,
  session: ImportSessionRow,
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
    if (!(await exists("media", finalKey, backend))) {
      if (!(await exists("_uploads", stagingImageKey(id), backend))) {
        throw new ApiError(409, "prepared_object_missing", "准备好的图片文件不存在");
      }
      await copyObject("_uploads", stagingImageKey(id), "media", finalKey, backend);
      copiedImage = true;
    }
    if (!(await exists("thumbs", thumbKey, backend))) {
      if (!(await exists("_uploads", payload.prepared_thumbnail_key, backend))) {
        throw new ApiError(409, "prepared_thumbnail_missing", "准备好的缩略图不存在");
      }
      await copyObject(
        "_uploads",
        payload.prepared_thumbnail_key,
        "thumbs",
        thumbKey,
        backend
      );
      copiedThumbnail = true;
    }

    const classification = resolveClassification(payload, {
      device: payload.resolved_device,
      brightness: payload.resolved_brightness
    });
    const result = await withTransaction(async (client) => {
      await ensureTheme(client, payload.theme);
      await ensureAuthor(client, payload.author);
      const insertedRow = await client.query(
        `INSERT INTO metadata(id, image_time, device, brightness, theme, width, height, image_size, ext,
         object_key, storage_slug, title, description, source, original, md5, thumbnail_size, author)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (id) DO NOTHING RETURNING *`,
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
      const inserted = Boolean(insertedRow.rowCount);
      const image = (inserted
        ? insertedRow.rows[0]
        : (await client.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0]
      ) as ImageRecord;
      await replaceImageTags(client, image.id, resolvedTags);
      const finalized = await client.query(
        "UPDATE import_session SET status='finalized', updated_at=now() WHERE id=$1 AND status='committing'",
        [id]
      );
      if (!finalized.rowCount) {
        throw new ApiError(409, "invalid_import_state", "导入任务提交状态已变化");
      }
      return { image, inserted };
    });
    databaseCommitted = true;

    await Promise.all([
      removeObject("_uploads", stagingImageKey(id), backend).catch(() => undefined),
      removeObject("_uploads", payload.prepared_thumbnail_key, backend).catch(() => undefined)
    ]);
    await finishImport(result.image, payload);
    return { status: "imported" as const, item: await publicImage(result.image) };
  } catch (error) {
    if (!databaseCommitted) {
      await Promise.all([
        copiedImage
          ? removeObject("media", finalKey, backend).catch(() => undefined)
          : Promise.resolve(),
        copiedThumbnail
          ? removeObject("thumbs", thumbKey, backend).catch(() => undefined)
          : Promise.resolve()
      ]);
    }
    throw error;
  }
}

async function commitProxySession(
  id: string,
  session: ImportSessionRow,
  payload: PreparedPayload
) {
  const backend = session.storage_slug;
  const classification = resolveClassification(payload, {
    device: payload.resolved_device,
    brightness: payload.resolved_brightness
  });
  const linkKey = linkThumbnailKey(
    classification.device,
    classification.brightness,
    payload.theme,
    id
  );
  let copiedLink = false;
  let databaseCommitted = false;

  try {
    const resolvedTags = await resolveTagNames(payload.tags ?? []);
    if (!(await exists("link", linkKey, backend))) {
      if (!(await exists("_uploads", payload.prepared_thumbnail_key, backend))) {
        throw new ApiError(409, "prepared_thumbnail_missing", "准备好的缩略图不存在");
      }
      await copyObject(
        "_uploads",
        payload.prepared_thumbnail_key,
        "link",
        linkKey,
        backend
      );
      copiedLink = true;
    }

    const result = await withTransaction(async (client) => {
      await ensureTheme(client, payload.theme);
      await ensureAuthor(client, payload.author);
      const insertedRow = await client.query(
        `INSERT INTO metadata(id, image_time, device, brightness, theme, width, height, ext,
         object_key, storage_slug, is_link, title, description, source, original, md5, thumbnail_size, author)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (object_key) DO NOTHING RETURNING *`,
        [
          id,
          session.image_time,
          classification.device,
          classification.brightness,
          payload.theme,
          payload.width,
          payload.height,
          payload.ext,
          payload.source_url,
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
      const inserted = Boolean(insertedRow.rowCount);
      const image = inserted
        ? insertedRow.rows[0] as ImageRecord
        : (await client.query(
            "SELECT * FROM metadata WHERE id=$1",
            [id]
          )).rows[0] as ImageRecord | undefined;
      if (image) await replaceImageTags(client, image.id, resolvedTags);
      const finalized = await client.query(
        "UPDATE import_session SET status='finalized', updated_at=now() WHERE id=$1 AND status='committing'",
        [id]
      );
      if (!finalized.rowCount) {
        throw new ApiError(409, "invalid_import_state", "导入任务提交状态已变化");
      }
      return { image, inserted };
    });
    databaseCommitted = true;

    await removeObject("_uploads", payload.prepared_thumbnail_key, backend).catch(() => undefined);
    if (!result.image) {
      await removeObject("link", linkKey, backend).catch(() => undefined);
      return { status: "duplicate" as const };
    }
    await finishImport(result.image, payload);
    return { status: "imported" as const, item: await publicImage(result.image) };
  } catch (error) {
    if (!databaseCommitted && copiedLink) {
      await removeObject("link", linkKey, backend).catch(() => undefined);
    }
    throw error;
  }
}

export async function commitImportSession(id: string, metadata: ImportMetadata) {
  const lockClient = await pool.connect();
  const lockKey = `import.commit:${id}`;
  const locked = Boolean((await lockClient.query(
    "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
    [lockKey]
  )).rows[0]?.locked);
  if (!locked) {
    lockClient.release();
    throw new ApiError(409, "import_already_finalizing", "Import is already being committed");
  }

  try {
    let session = (await pool.query(
      "SELECT * FROM import_session WHERE id=$1",
      [id]
    )).rows[0] as ImportSessionRow | undefined;
    if (!session) throw new ApiError(404, "not_found", "导入任务不存在");
    if (session.status === "finalized") {
      const image = (await pool.query(
        "SELECT * FROM metadata WHERE id=$1",
        [id]
      )).rows[0] as ImageRecord | undefined;
      if (!image) return { status: "duplicate" as const };
      await finishImport(image, session.prepared_payload as PreparedPayload);
      return { status: "imported" as const, item: await publicImage(image) };
    }
    if (!["ready", "committing"].includes(session.status)) {
      throw new ApiError(409, "invalid_import_state", "图片尚未准备完成");
    }

    return await withImportLease(id, async () => {
      if (session?.status === "ready") {
        const payload = { ...session.prepared_payload, ...metadata } as PreparedPayload;
        const metadataPayload: MetadataPayload = {
          ...metadata,
          image_time: new Date(session.image_time).toISOString()
        };
        const classification = resolveClassification(metadata, {
          device: payload.resolved_device,
          brightness: payload.resolved_brightness
        });
        const finalKey = session.mode === "proxy"
          ? ""
          : storageObjectKey(
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
           RETURNING *`,
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
        session = claimed.rows[0] as ImportSessionRow;
        await notifyImportStatus(id);
      }

      if (!session) throw new ApiError(404, "not_found", "导入任务不存在");
      const currentSession = session;
      const payload = currentSession.prepared_payload as PreparedPayload;
      const result = await withStorageMutationLock(() => currentSession.mode === "proxy"
        ? commitProxySession(id, currentSession, payload)
        : commitStoredImageSession(id, currentSession, payload));
      await notifyImportStatus(id);
      return result;
    });
  } finally {
    await lockClient.query(
      "SELECT pg_advisory_unlock(hashtext($1))",
      [lockKey]
    ).catch(() => undefined);
    lockClient.release();
  }
}
