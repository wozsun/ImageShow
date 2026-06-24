import type { Hono } from "hono";
import { v7 as uuidv7 } from "uuid";
import { adminApiBasePath, appConfig, categoryKey, indexKey } from "@imageshow/shared";
import { pool } from "../core/db.js";
import { ApiError, ok } from "../core/http.js";
import { storageObjectKey } from "../storage/image-paths.js";
import { publicImage, uploadSessionResponse, type ImageRecord, type UploadSessionRecord } from "../images/presenter.js";
import { bumpFolder, invalidateImageReadCaches, invalidateMd5Cache } from "../core/redis.js";
import { enqueue } from "../jobs/tasks.js";
import { parse, uploadCreateInput, uuidInput } from "../core/validation.js";
import { contentType, validateImage } from "../images/processing.js";
import { exists, moveObject, objectStat, storageConfigForBackend, writeUploadFromWeb } from "../storage/storage.js";
import { getImageMaxLongEdge, getStorageConfig, getUploadLimitBytes } from "../config/settings.js";
import { isReservedSubdomain } from "../core/theme-host.js";

export function registerUploadRoutes(app: Hono) {
  app.post(`${adminApiBasePath}/uploads/create`, async (c) => {
    const input = parse(uploadCreateInput, await c.req.json().catch(() => ({})));
    if (isReservedSubdomain(input.theme)) throw new ApiError(400, "theme_reserved", "Theme conflicts with a reserved subdomain prefix", { theme: input.theme });
    const limit = await getUploadLimitBytes();
    if (input.size > limit) throw new ApiError(400, "upload_too_large", "Upload too large", { limit });
    const dimensionLimit = await getImageMaxLongEdge();
    if (Math.max(input.width, input.height) > dimensionLimit) {
      throw new ApiError(400, "image_too_large", "Image dimensions exceed the configured limit", { limit: dimensionLimit });
    }
    const id = uuidv7();
    const expiresAt = new Date(Date.now() + appConfig.uploadTtlSeconds * 1000);
    const payload = {
      version: 1,
      original_filename: input.original_filename,
      client_ext: input.client_ext,
      device: input.device,
      brightness: input.brightness,
      theme: input.theme,
      title: input.title,
      description: input.description,
      source: input.source,
      original: input.original,
      md5: input.md5,
      width: input.width,
      height: input.height
    };
    const storage = await getStorageConfig();
    // The batch may pin a specific backend; otherwise it follows the default.
    // Validate S3 credentials here so an unconfigured target fails fast instead
    // of producing a broken presigned URL downstream.
    const backend = input.storage_backend ?? storage.backend;
    if (backend === "s3") storageConfigForBackend(storage, "s3");
    const result = await pool.query(
      `INSERT INTO upload_session(id, staging_object_key, expected_size, metadata_payload, idempotency_key, expires_at, storage_backend)
       VALUES($1, $2, $3, $4::jsonb, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=excluded.idempotency_key
       RETURNING *`,
      [id, id, input.size, JSON.stringify(payload), input.idempotency_key, expiresAt, backend]
    );
    return c.json(ok(await uploadSessionResponse(result.rows[0] as UploadSessionRecord)));
  });

  // Authenticated admin session + CSRF (enforced by the /api/admin middleware) is
  // the only gate here; the session row is looked up by the URL id, so no separate
  // upload token is needed.
  app.put(`${adminApiBasePath}/uploads/:id/file`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    const session = (await pool.query("SELECT * FROM upload_session WHERE id=$1 AND status='created'", [id])).rows[0];
    if (!session) throw new ApiError(409, "invalid_upload_state", "Invalid upload state");
    if (!c.req.raw.body) throw new ApiError(400, "empty_body", "Empty body");
    await writeUploadFromWeb(session.staging_object_key, c.req.raw.body, Number(session.expected_size), session.storage_backend);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/uploads/:id/complete`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    const lockClient = await pool.connect();
    const lockKey = `upload.complete:${id}`;
    const locked = Boolean((await lockClient.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockKey])).rows[0]?.locked);
    if (!locked) {
      lockClient.release();
      throw new ApiError(409, "upload_already_finalizing", "Upload is already being finalized");
    }
    try {
      const session = (await pool.query("SELECT * FROM upload_session WHERE id=$1", [id])).rows[0];
      if (!session) throw new ApiError(404, "not_found", "Upload session not found");
      if (session.status === "finalized") {
        const image = (await pool.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0];
        if (!image) throw new ApiError(409, "finalized_image_missing", "Finalized image metadata is missing");
        return c.json(ok({ item: await publicImage(image as ImageRecord) }));
      }
      if (!["created", "finalizing"].includes(session.status)) throw new ApiError(409, "invalid_upload_state", "Invalid upload state");
      const meta = session.metadata_payload;
      let finalKey = String(session.final_object_key ?? "");
      const finalObjectExists = finalKey ? await exists("objects", finalKey, session.storage_backend) : false;
      const validationPrefix = finalObjectExists ? "objects" as const : "_uploads" as const;
      const validationKey = finalObjectExists ? finalKey : session.staging_object_key;
      const expectedExt = (finalKey.split(".").pop() || meta.client_ext) as "jpg" | "png" | "webp" | "gif" | "avif";
      const backend = session.storage_backend;
      // S3 already guarantees object persistence after a successful PUT. For an
      // authenticated administrator upload, trust the browser's decoded image
      // dimensions and MD5, and only verify object size with HEAD. Thumbnail
      // generation still decodes the image asynchronously and rejects bad data.
      const dimensions = backend === "s3"
        ? { width: Number(meta.width), height: Number(meta.height), ext: expectedExt, md5: String(meta.md5), size: (await objectStat(validationPrefix, validationKey, backend)).size }
        : await validateImage(validationPrefix, validationKey, expectedExt, backend);
      if (dimensions.size !== Number(session.expected_size)) {
        throw new ApiError(400, "size_mismatch", "Upload size mismatch", { expected: Number(session.expected_size), actual: dimensions.size });
      }
      const ext = dimensions.ext;
      const actualMd5 = dimensions.md5;
      if (meta.md5 !== actualMd5) throw new ApiError(400, "md5_mismatch", "MD5 mismatch", { expected: meta.md5, actual: actualMd5 });
      const cat = categoryKey(meta.device, meta.brightness, meta.theme);
      finalKey ||= storageObjectKey(meta.device, meta.brightness, meta.theme, id, ext);
      if (session.status === "created") {
        const claimed = await pool.query(
          "UPDATE upload_session SET status='finalizing', final_object_key=$2, updated_at=now() WHERE id=$1 AND status='created' RETURNING id",
          [id, finalKey]
        );
        if (!claimed.rowCount) throw new ApiError(409, "upload_already_finalizing", "Upload is already being finalized");
      }
      if (!finalObjectExists) await moveObject("_uploads", session.staging_object_key, "objects", finalKey, contentType(ext), backend);
      const client = await pool.connect();
      let image;
      let inserted = false;
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO category(category_key, device, brightness, theme, count)
           VALUES($1, $2, $3, $4, 0)
           ON CONFLICT (category_key) DO NOTHING`,
          [cat, meta.device, meta.brightness, meta.theme]
        );
        const catRow = (await client.query("SELECT * FROM category WHERE category_key=$1 FOR UPDATE", [cat])).rows[0];
        const nextIndex = Number(catRow.count) + 1;
        const idx = indexKey(cat, nextIndex);
        const insertResult = await client.query(
          `INSERT INTO metadata(id, device, brightness, theme, category_key, category_index, index_key, width, height, ext, object_key, storage_backend, title, description, source, original, md5)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [id, meta.device, meta.brightness, meta.theme, cat, nextIndex, idx, dimensions.width, dimensions.height, ext, finalKey, backend, meta.title, meta.description, meta.source, meta.original, actualMd5]
        );
        inserted = Boolean(insertResult.rowCount);
        if (inserted) await client.query("UPDATE category SET count=count+1, updated_at=now() WHERE category_key=$1", [cat]);
        await client.query("UPDATE upload_session SET status='finalized', updated_at=now() WHERE id=$1 AND status='finalizing'", [id]);
        image = (await client.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0];
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      await enqueue("thumb.generate", id, { object_key: finalKey }, `thumb.generate:${id}`);
      if (inserted) await bumpFolder(cat, 1);
      await invalidateMd5Cache(actualMd5);
      if (inserted) await invalidateImageReadCaches();
      return c.json(ok({ item: await publicImage(image as ImageRecord) }));
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined);
      lockClient.release();
    }
  });
}
