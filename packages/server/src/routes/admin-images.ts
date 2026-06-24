import type { Hono } from "hono";
import { adminApiBasePath, indexKey } from "@imageshow/shared";
import { cleanupEmptyCategories, pool } from "../core/db.js";
import { ApiError, ok } from "../core/http.js";
import { batchDeleteImages } from "../images/batch.js";
import { storageObjectKey, thumbnailObjectKey } from "../storage/image-paths.js";
import { publicImage, publicImages, type ImageRecord } from "../images/presenter.js";
import { bumpFolder, getMd5Cache, invalidateImageReadCaches, invalidateMd5Cache, invalidateMd5Caches, setMd5Cache } from "../core/redis.js";
import { enqueue } from "../jobs/tasks.js";
import { restoreImageFromTrash } from "../jobs/restore.js";
import { adminImageListQuery, batchMigrateStorageInput, imageIdsInput, md5Input, metadataInput, migrateStorageInput, normalizedCategory, parse, uuidInput } from "../core/validation.js";
import { copyObject, removeObject } from "../storage/storage.js";
import { migrateImageStorage, type MigrateRow } from "../storage/migration.js";
import { getStorageConfig, type StorageBackend } from "../config/settings.js";
import { getRuntimeConfig } from "../config/env.js";
import { isReservedSubdomain } from "../core/theme-host.js";
import { decodeImageCursor, encodeImageCursor } from "../images/cursor.js";

async function restoreDeletedImage(id: string, missingIsError = true) {
  const result = await restoreImageFromTrash(id);
  if (result.status === "not_deleted") {
    if (missingIsError) throw new ApiError(404, "not_found", "Deleted image not found");
    return false;
  }
  if (result.status === "object_missing") throw new ApiError(404, "object_missing", "Deleted image object is missing");
  await invalidateMd5Cache(result.image.md5 ?? "");
  await invalidateImageReadCaches();
  return true;
}

async function purgeDeletedImages(ids?: string[]) {
  const rows = (await pool.query(
    ids?.length
      ? "SELECT id, object_key, md5, storage_backend FROM metadata WHERE status='deleted' AND id = ANY($1::uuid[]) ORDER BY deleted_at ASC"
      : "SELECT id, object_key, md5, storage_backend FROM metadata WHERE status='deleted' ORDER BY deleted_at ASC",
    ids?.length ? [ids] : []
  )).rows as Array<{ id: string; object_key: string; md5: string; storage_backend: StorageBackend }>;
  const deletedRows: typeof rows = [];
  let failed = 0;
  for (let offset = 0; offset < rows.length; offset += 10) {
    await Promise.all(rows.slice(offset, offset + 10).map(async (row) => {
      try {
        await Promise.all([
          removeObject("objects", row.object_key, row.storage_backend),
          removeObject("trash", row.object_key, row.storage_backend),
          removeObject("thumbs", thumbnailObjectKey(row.object_key), row.storage_backend)
        ]);
        deletedRows.push(row);
      } catch {
        failed += 1;
      }
    }));
  }
  const deletedIds = deletedRows.map((row) => row.id);
  if (deletedIds.length) {
    await pool.query("DELETE FROM metadata WHERE id = ANY($1::uuid[]) AND status='deleted'", [deletedIds]);
    await pool.query(
      "UPDATE operation_log SET status='ignored', error='purged from trash', updated_at=now() WHERE target_id = ANY($1::text[]) AND type IN ('delete.finalize','restore.finalize') AND status IN ('pending','running','failed')",
      [deletedIds]
    );
    await invalidateMd5Caches(deletedRows.map((row) => row.md5));
    await cleanupEmptyCategories();
    await invalidateImageReadCaches();
  }
  return { requested: rows.length, deleted: deletedIds.length, failed };
}

export function registerAdminImageRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/overview`, async (c) => {
    const row = (await pool.query(`
      SELECT
        count(*) FILTER (WHERE status='ready' AND device<>'none' AND brightness<>'none')::int AS gallery,
        count(*) FILTER (WHERE status='ready' AND (device='none' OR brightness='none'))::int AS unset,
        count(*) FILTER (WHERE status='deleted')::int AS trash,
        count(*)::int AS total,
        count(*) FILTER (WHERE storage_backend='local')::int AS local,
        count(*) FILTER (WHERE storage_backend='s3')::int AS s3,
        count(DISTINCT theme) FILTER (WHERE status='ready' AND device<>'none' AND brightness<>'none')::int AS theme_count,
        count(*) FILTER (WHERE status='ready' AND device='pc' AND brightness<>'none')::int AS pc,
        count(*) FILTER (WHERE status='ready' AND device='mb' AND brightness<>'none')::int AS mb,
        count(*) FILTER (WHERE status='ready' AND brightness='dark' AND device<>'none')::int AS dark,
        count(*) FILTER (WHERE status='ready' AND brightness='light' AND device<>'none')::int AS light
      FROM metadata
    `)).rows[0];
    const topThemes = (await pool.query(`
      SELECT theme, count(*)::int AS count
      FROM metadata
      WHERE status='ready' AND device<>'none' AND brightness<>'none'
      GROUP BY theme
      ORDER BY count DESC, theme ASC
      LIMIT 8
    `)).rows;
    const recentLimit = getRuntimeConfig().admin.recent_uploads;
    const recentRows = (await pool.query("SELECT * FROM metadata WHERE status='ready' ORDER BY created_at DESC, id DESC LIMIT $1", [recentLimit])).rows;
    const recent = await publicImages(recentRows as ImageRecord[]);
    const pendingTasks = (await pool.query("SELECT count(*)::int AS pending FROM operation_log WHERE status IN ('pending','running')")).rows[0].pending;
    const storage = await getStorageConfig();
    return c.json(ok({
      gallery: row.gallery, unset: row.unset, trash: row.trash, total: row.total,
      local: row.local, s3: row.s3, theme_count: row.theme_count, default_backend: storage.backend,
      pc: row.pc, mb: row.mb, dark: row.dark, light: row.light, pending_tasks: pendingTasks,
      top_themes: topThemes.map((t) => ({ theme: t.theme, count: t.count })),
      recent: recent.map((r) => ({ id: r.id, title: r.title, thumb_url: r.thumb_url, created_at: r.created_at }))
    }));
  });

  app.get(`${adminApiBasePath}/images`, async (c) => {
    const q = parse(adminImageListQuery, Object.fromEntries(new URL(c.req.url).searchParams));
    const limit = q.limit;
    const params: unknown[] = [q.status];
    const where = ["status = $1"];
    if (q.status === "ready") {
      where.push(q.unset ? "(device = 'none' OR brightness = 'none')" : "device <> 'none' AND brightness <> 'none'");
    }
    if (q.d) { params.push(q.d); where.push(`device = $${params.length}`); }
    if (q.b) { params.push(q.b); where.push(`brightness = $${params.length}`); }
    if (q.t) { params.push(q.t); where.push(`theme = $${params.length}`); }
    const total = Number((await pool.query(
      `SELECT count(*)::int AS count FROM metadata WHERE ${where.join(" AND ")}`,
      params
    )).rows[0]?.count ?? 0);
    if (q.cursor) {
      const cursor = decodeImageCursor(q.cursor);
      params.push(cursor.createdAt, cursor.id);
      where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit + 1);
    const result = await pool.query(
      `SELECT *, created_at::text AS cursor_created_at
       FROM metadata
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
      params
    );
    const visibleRows = result.rows.slice(0, limit) as Array<ImageRecord & { id: string; cursor_created_at: string }>;
    const hasNext = result.rows.length > limit;
    const last = visibleRows.at(-1);
    const items = await publicImages(visibleRows);
    return c.json(ok({ items, limit, total, has_next: hasNext, next_cursor: hasNext && last ? encodeImageCursor(last) : null }));
  });

  app.get(`${adminApiBasePath}/images/:id`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    const result = await pool.query("SELECT * FROM metadata WHERE id=$1", [id]);
    if (!result.rows[0]) throw new ApiError(404, "not_found", "Image not found");
    return c.json(ok({ item: await publicImage(result.rows[0] as ImageRecord) }));
  });

  app.post(`${adminApiBasePath}/images/check-md5`, async (c) => {
    const input = parse(md5Input, await c.req.json().catch(() => ({})));
    const cached = await getMd5Cache(input.md5);
    if (cached) return c.json(ok({ md5: input.md5, exists: cached.length > 0, items: cached }));
    const rows = await publicImages((await pool.query(
      "SELECT * FROM metadata WHERE md5=$1 ORDER BY status ASC, created_at DESC LIMIT 20",
      [input.md5]
    )).rows as ImageRecord[]);
    await setMd5Cache(input.md5, rows);
    return c.json(ok({ md5: input.md5, exists: rows.length > 0, items: rows }));
  });

  app.post(`${adminApiBasePath}/images/:id/delete`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    const client = await pool.connect();
    let oldCategory = "";
    try {
      await client.query("BEGIN");
      const image = (await client.query("SELECT * FROM metadata WHERE id=$1 AND status='ready' FOR UPDATE", [id])).rows[0];
      if (!image) throw new ApiError(404, "not_found", "Ready image not found");
      oldCategory = image.category_key;
      const cat = (await client.query("SELECT * FROM category WHERE category_key=$1 FOR UPDATE", [image.category_key])).rows[0];
      const count = Number(cat.count);
      await client.query("UPDATE metadata SET status='deleted', deleted_at=now(), updated_at=now() WHERE id=$1", [id]);
      if (image.category_index !== count) {
        const filler = (await client.query("SELECT * FROM metadata WHERE category_key=$1 AND status='ready' AND category_index=$2 FOR UPDATE", [image.category_key, count])).rows[0];
        if (filler) await client.query("UPDATE metadata SET category_index=$2, index_key=$3, updated_at=now() WHERE id=$1", [filler.id, image.category_index, indexKey(image.category_key, image.category_index)]);
      }
      await client.query("UPDATE category SET count=count-1, updated_at=now() WHERE category_key=$1", [image.category_key]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await enqueue("delete.finalize", id);
    await bumpFolder(oldCategory, -1);
    await cleanupEmptyCategories();
    const deletedImage = (await pool.query("SELECT md5 FROM metadata WHERE id=$1", [id])).rows[0];
    await invalidateMd5Cache(deletedImage?.md5 ?? "");
    await invalidateImageReadCaches();
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/images/:id/restore`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    await restoreDeletedImage(id);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/images/batch-restore`, async (c) => {
    const input = parse(imageIdsInput, await c.req.json().catch(() => ({})));
    let restored = 0;
    let ignored = 0;
    const failedIds: string[] = [];
    for (const id of input.ids) {
      try {
        if (await restoreDeletedImage(id, false)) restored += 1;
        else ignored += 1;
      } catch {
        failedIds.push(id);
      }
    }
    return c.json(ok({ requested: input.ids.length, restored, ignored, failed: failedIds.length, failed_ids: failedIds }));
  });

  app.post(`${adminApiBasePath}/images/batch-delete`, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const ids = Array.isArray(body.ids) ? body.ids : [];
    return c.json(ok(await batchDeleteImages(ids.map(String))));
  });

  app.post(`${adminApiBasePath}/images/empty-trash`, async (c) => {
    return c.json(ok(await purgeDeletedImages()));
  });

  app.post(`${adminApiBasePath}/images/:id/purge`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    const result = await purgeDeletedImages([id]);
    if (!result.requested) throw new ApiError(404, "not_found", "Deleted image not found");
    if (result.failed) throw new ApiError(502, "storage_delete_failed", "Failed to permanently delete the stored image");
    return c.json(ok(result));
  });

  app.post(`${adminApiBasePath}/images/:id/migrate-storage`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    const input = parse(migrateStorageInput, await c.req.json().catch(() => ({})));
    const row = (await pool.query("SELECT id, object_key, ext, status, storage_backend, category_key FROM metadata WHERE id=$1", [id])).rows[0];
    if (!row) throw new ApiError(404, "not_found", "Image not found");
    const result = await migrateImageStorage(row as MigrateRow, input.target);
    if (result === "missing") throw new ApiError(502, "storage_object_missing", "Source object is missing");
    await bumpFolder(row.category_key, 0);
    await invalidateImageReadCaches();
    const updated = (await pool.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0];
    return c.json(ok({ result, item: await publicImage(updated as ImageRecord) }));
  });

  app.post(`${adminApiBasePath}/images/batch-migrate-storage`, async (c) => {
    const input = parse(batchMigrateStorageInput, await c.req.json().catch(() => ({})));
    const rows = (await pool.query("SELECT id, object_key, ext, status, storage_backend, category_key FROM metadata WHERE id = ANY($1::uuid[])", [input.ids])).rows;
    let migrated = 0;
    let unchanged = 0;
    let failed = 0;
    const failedIds: string[] = [];
    const categories = new Set<string>();
    for (const row of rows) {
      try {
        const result = await migrateImageStorage(row as MigrateRow, input.target);
        if (result === "migrated") { migrated += 1; categories.add(row.category_key); }
        else if (result === "missing") { failed += 1; failedIds.push(row.id); }
        else unchanged += 1;
      } catch {
        failed += 1;
        failedIds.push(row.id);
      }
    }
    for (const category of categories) await bumpFolder(category, 0);
    if (migrated) await invalidateImageReadCaches();
    return c.json(ok({ requested: input.ids.length, migrated, unchanged, failed, failed_ids: failedIds }));
  });

  app.post(`${adminApiBasePath}/images/:id`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    const body = await c.req.json().catch(() => ({}));
    const current = (await pool.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0] as ImageRecord | undefined;
    if (!current) throw new ApiError(404, "not_found", "Image not found");
    const next = parse(metadataInput.partial(), body);
    if (next.theme && isReservedSubdomain(next.theme)) throw new ApiError(400, "theme_reserved", "Theme conflicts with a reserved subdomain prefix", { theme: next.theme });
    const categoryChanged = next.device || next.brightness || next.theme;
    if (!categoryChanged) {
      const result = await pool.query(
        "UPDATE metadata SET title=COALESCE($2,title), description=COALESCE($3,description), source=COALESCE($4,source), original=COALESCE($5,original), updated_at=now() WHERE id=$1 RETURNING *",
        [id, next.title, next.description, next.source, next.original]
      );
      await invalidateMd5Cache(current.md5 ?? "");
      await invalidateImageReadCaches();
      return c.json(ok({ item: await publicImage(result.rows[0] as ImageRecord) }));
    }
    const client = await pool.connect();
    let sourceImage = current;
    let newCat = "";
    let newKey = "";
    let copiedNewObject = false;
    try {
      await client.query("BEGIN");
      const locked = (await client.query("SELECT * FROM metadata WHERE id=$1 FOR UPDATE", [id])).rows[0] as ImageRecord | undefined;
      if (!locked) throw new ApiError(404, "not_found", "Image not found");
      if (locked.status !== "ready") throw new ApiError(409, "invalid_image_state", "Only ready images can change category");
      sourceImage = locked;
      const device = next.device ?? locked.device;
      const brightness = next.brightness ?? locked.brightness;
      const theme = next.theme ?? locked.theme;
      newCat = normalizedCategory({ device, brightness, theme });
      if (newCat === locked.category_key) {
        await client.query("COMMIT");
        return c.json(ok({ item: await publicImage(locked) }));
      }
      newKey = storageObjectKey(device, brightness, theme, id, locked.ext);
      for (const cat of [locked.category_key, newCat].sort()) {
        await client.query("INSERT INTO category(category_key, device, brightness, theme, count) VALUES($1,$2,$3,$4,0) ON CONFLICT DO NOTHING", [cat, ...(cat === newCat ? [device, brightness, theme] : [locked.device, locked.brightness, locked.theme])]);
        await client.query("SELECT * FROM category WHERE category_key=$1 FOR UPDATE", [cat]);
      }
      await copyObject("objects", locked.object_key, "objects", newKey, locked.storage_backend);
      copiedNewObject = true;
      const oldCount = Number((await client.query("SELECT count FROM category WHERE category_key=$1", [locked.category_key])).rows[0].count);
      if (locked.category_index !== oldCount) {
        const filler = (await client.query("SELECT id FROM metadata WHERE category_key=$1 AND status='ready' AND category_index=$2 FOR UPDATE", [locked.category_key, oldCount])).rows[0];
        if (filler) await client.query("UPDATE metadata SET category_index=$2, index_key=$3, updated_at=now() WHERE id=$1", [filler.id, locked.category_index, indexKey(locked.category_key, locked.category_index)]);
      }
      const newCount = Number((await client.query("SELECT count FROM category WHERE category_key=$1", [newCat])).rows[0].count) + 1;
      await client.query("UPDATE category SET count=count-1, updated_at=now() WHERE category_key=$1", [locked.category_key]);
      await client.query("UPDATE category SET count=count+1, updated_at=now() WHERE category_key=$1", [newCat]);
      await client.query(
        "UPDATE metadata SET device=$2, brightness=$3, theme=$4, category_key=$5, category_index=$6, index_key=$7, object_key=$8, updated_at=now() WHERE id=$1",
        [id, device, brightness, theme, newCat, newCount, indexKey(newCat, newCount), newKey]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (copiedNewObject && newKey) {
        const adopted = await client.query("SELECT 1 FROM metadata WHERE id=$1 AND object_key=$2", [id, newKey])
          .then((result) => Boolean(result.rowCount))
          .catch(() => false);
        if (!adopted) {
          await removeObject("objects", newKey, sourceImage.storage_backend).catch(() => enqueue(
            "move.cleanup",
            id,
            { object_key: newKey, backend: sourceImage.storage_backend },
            `move.cleanup:${id}:${newKey}`
          ).catch(() => undefined));
        }
      }
      throw error;
    } finally {
      client.release();
    }
    await Promise.all([
      removeObject("objects", sourceImage.object_key, sourceImage.storage_backend),
      removeObject("thumbs", thumbnailObjectKey(sourceImage.object_key), sourceImage.storage_backend)
    ]).catch(() => enqueue(
      "move.cleanup",
      id,
      { object_key: sourceImage.object_key, backend: sourceImage.storage_backend },
      `move.cleanup:${id}:${sourceImage.object_key}`
    ).catch(() => undefined));
    await enqueue("thumb.generate", id);
    await bumpFolder(sourceImage.category_key, -1);
    await bumpFolder(newCat, 1);
    await cleanupEmptyCategories();
    await invalidateMd5Cache(sourceImage.md5 ?? "");
    await invalidateImageReadCaches();
    const updated = (await pool.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0];
    return c.json(ok({ item: await publicImage(updated as ImageRecord) }));
  });
}
