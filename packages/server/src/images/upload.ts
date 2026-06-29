import type { z } from "zod";
import { v7 as uuidv7 } from "uuid";
import { appConfig, categoryKey, indexKey } from "@imageshow/shared";
import { adjustCategoryCount, pool, upsertCategory, withTransaction } from "../core/db.js";
import { ApiError } from "../core/http.js";
import { storageObjectKey, thumbnailObjectKey } from "../storage/image-paths.js";
import { publicImage, uploadSessionResponse, type ImageRecord, type UploadSessionRecord } from "./presenter.js";
import { bumpFolder, invalidateImageReadCaches, invalidateMd5Cache } from "../core/redis.js";
import { contentType, createThumbnail, probeImageBytes } from "./processing.js";
import { detectBrightness } from "./brightness.js";
import { exists, moveObject, readStorageBuffer, writeStorageBuffer, writeUploadFromWeb } from "../storage/storage.js";
import { assertStorageUploadable, getDefaultStorageSlug, getUploadLimitBytes } from "../config/settings.js";
import { isReservedSubdomain } from "../themes/host.js";
import { ensureTheme } from "../themes/service.js";
import { ensureAuthor } from "../authors/service.js";
import { setImageTags } from "../tags/service.js";
import { uploadCreateInput } from "../core/validation.js";

type UploadCreateInput = z.infer<typeof uploadCreateInput>;

// Creates a pending upload session and returns the (always server-mediated) upload
// target. Validates the theme and byte-size limit, and — for an S3-pinned batch — the
// S3 credentials, so an unconfigured target fails fast here. (Dimensions/ext/md5 are
// verified later against the actual bytes at finalize.)
export async function createUploadSession(input: UploadCreateInput) {
  if (isReservedSubdomain(input.theme)) throw new ApiError(400, "theme_reserved", "Theme conflicts with a reserved subdomain prefix", { theme: input.theme });
  const limit = await getUploadLimitBytes();
  if (input.size > limit) throw new ApiError(400, "upload_too_large", "Upload too large", { limit });
  // No dimension precheck here: the server probes the real width/height/ext from the
  // bytes at finalize (which enforces the pixel limit), and the client blocks oversized
  // images before upload — so only size + md5 are declared, to verify the bytes.
  const id = uuidv7();
  const expiresAt = new Date(Date.now() + appConfig.uploadTtlSeconds * 1000);
  const payload = {
    version: 1,
    device: input.device,
    brightness: input.brightness,
    theme: input.theme,
    author: input.author,
    title: input.title,
    description: input.description,
    source: input.source,
    original: input.original,
    md5: input.md5,
    tags: input.tags
  };
  // The batch may pin a specific backend; otherwise it follows the default. Validate
  // the target is writable here so an unconfigured/unknown backend fails fast instead
  // of accepting bytes we can't store.
  const backend = input.storage_slug ?? await getDefaultStorageSlug();
  await assertStorageUploadable(backend);
  const result = await pool.query(
    `INSERT INTO upload_session(id, staging_object_key, expected_size, metadata_payload, idempotency_key, expires_at, storage_slug)
     VALUES($1, $2, $3, $4::jsonb, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=excluded.idempotency_key
     RETURNING *`,
    [id, id, input.size, JSON.stringify(payload), input.idempotency_key, expiresAt, backend]
  );
  // The browser PUTs the bytes to this server, which streams them on to the
  // session's backend (S3 or local) — see writeUploadFile / writeUploadFromWeb.
  return uploadSessionResponse(result.rows[0] as UploadSessionRecord);
}

// Streams the request body into the session's staging object. The authenticated
// admin session (enforced by the /api/admin middleware) is the only gate; the
// session row is looked up by id, so no separate upload token is needed.
export async function writeUploadFile(id: string, body: ReadableStream<Uint8Array> | null) {
  const session = (await pool.query("SELECT * FROM upload_session WHERE id=$1 AND status='created'", [id])).rows[0];
  if (!session) throw new ApiError(409, "invalid_upload_state", "Invalid upload state");
  if (!body) throw new ApiError(400, "empty_body", "Empty body");
  await writeUploadFromWeb(session.staging_object_key, body, Number(session.expected_size), session.storage_slug);
}

// Finalizes an uploaded object into a gallery image, doing the full job synchronously
// so a returned image is genuinely ready: validates bytes/size/md5, auto-detects
// brightness when requested ("auto"), moves the staging object into place, generates the thumbnail,
// assigns the category index, inserts the metadata row, and applies tags. No
// background queue work is left pending. Guarded by
// a per-session advisory lock and idempotent (a re-run after finalize returns the
// existing image).
export async function finalizeUpload(id: string) {
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
      return publicImage(image as ImageRecord);
    }
    if (!["created", "finalizing"].includes(session.status)) throw new ApiError(409, "invalid_upload_state", "Invalid upload state");
    const meta = session.metadata_payload;
    let finalKey = String(session.final_object_key ?? "");
    const finalObjectExists = finalKey ? await exists("objects", finalKey, session.storage_slug) : false;
    const sourcePrefix = finalObjectExists ? "objects" as const : "_uploads" as const;
    const sourceKey = finalObjectExists ? finalKey : session.staging_object_key;
    const backend = session.storage_slug;
    // Read the uploaded bytes once; validation, brightness detection and the thumbnail
    // all work on this single buffer. Doing the heavy work here (rather than deferring
    // to the background queue) is deliberate: the upload isn't reported "done" until
    // it is fully processed and in the database.
    const buffer = await readStorageBuffer(sourcePrefix, sourceKey, backend);
    const probe = await probeImageBytes(buffer);
    if (probe.size !== Number(session.expected_size)) {
      throw new ApiError(400, "size_mismatch", "Upload size mismatch", { expected: Number(session.expected_size), actual: probe.size });
    }
    // The buffer lets us verify the browser-declared md5 for every backend, so a
    // corrupt object fails the upload here rather than being served later.
    if (meta.md5 !== probe.md5) throw new ApiError(400, "md5_mismatch", "MD5 mismatch", { expected: meta.md5, actual: probe.md5 });
    const ext = probe.ext;
    // The thumbnail is both stored and the artifact we classify brightness from, so
    // build it once up front.
    const thumbnail = await createThumbnail(buffer);
    // "auto" brightness (the default) means "detect it": resolve from the thumbnail we just
    // built — the same 512px webp the re-detect path reads — so a later re-detection yields
    // the same verdict and we skip a second full-res decode. Otherwise the value is the
    // concrete dark/light the user picked. Device is already concrete (pc/mb) from the client.
    const brightness = meta.brightness === "auto" ? await detectBrightness(thumbnail) : meta.brightness;
    const cat = categoryKey(meta.device, brightness, meta.theme);
    finalKey ||= storageObjectKey(meta.device, brightness, meta.theme, id, ext);
    if (session.status === "created") {
      const claimed = await pool.query(
        "UPDATE upload_session SET status='finalizing', final_object_key=$2, updated_at=now() WHERE id=$1 AND status='created' RETURNING id",
        [id, finalKey]
      );
      if (!claimed.rowCount) throw new ApiError(409, "upload_already_finalizing", "Upload is already being finalized");
    }
    if (!finalObjectExists) await moveObject("_uploads", session.staging_object_key, "objects", finalKey, contentType(ext), backend);
    // Thumbnail is written before the row commits so a successful finalize always has
    // its thumbnail present (no "ready but thumbnailless" window).
    await writeStorageBuffer("thumbs", thumbnailObjectKey(finalKey), thumbnail, "image/webp", backend);
    const { image, inserted } = await withTransaction(async (client) => {
      await upsertCategory(client, cat, meta.device, brightness, meta.theme);
      // Register the theme and author so both are manageable (display name / aliases).
      await ensureTheme(client, meta.theme);
      await ensureAuthor(client, meta.author);
      const catRow = (await client.query("SELECT * FROM category WHERE category_key=$1 FOR UPDATE", [cat])).rows[0];
      const nextIndex = Number(catRow.count) + 1;
      const idx = indexKey(cat, nextIndex);
      const title = meta.title;
      const insertResult = await client.query(
        `INSERT INTO metadata(id, device, brightness, theme, category_key, category_index, index_key, width, height, image_size, ext, object_key, storage_slug, title, description, source, original, md5, thumbnail_size, author)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (id) DO NOTHING
         RETURNING *`,
        [id, meta.device, brightness, meta.theme, cat, nextIndex, idx, probe.width, probe.height, probe.size, ext, finalKey, backend, title, meta.description, meta.source, meta.original, probe.md5, thumbnail.byteLength, meta.author || null]
      );
      const inserted = Boolean(insertResult.rowCount);
      if (inserted) await adjustCategoryCount(client, cat, 1);
      await client.query("UPDATE upload_session SET status='finalized', updated_at=now() WHERE id=$1 AND status='finalizing'", [id]);
      const image = (await client.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0];
      return { image, inserted };
    });
    // Apply tags from the upload payload once the image row exists (new inserts
    // only). Done before the cache invalidation below so the gallery cache picks
    // up the tags on its next rebuild.
    if (inserted && Array.isArray(meta.tags) && meta.tags.length) await setImageTags(id, meta.tags as string[]);
    if (inserted) await bumpFolder(cat, 1);
    await invalidateMd5Cache(probe.md5);
    if (inserted) await invalidateImageReadCaches();
    return publicImage(image as ImageRecord);
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined);
    lockClient.release();
  }
}
