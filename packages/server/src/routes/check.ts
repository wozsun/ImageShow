import type { Hono } from "hono";
import { adminApiBasePath, appConfig } from "@imageshow/shared";
import { pool } from "../core/db.js";
import { ApiError, ok } from "../core/http.js";
import { storageObjectKey } from "../storage/image-paths.js";
import { inspectRedisState } from "../core/redis-inspect.js";
import { getFolderMap, invalidateImageReadCaches, rebuildFolderMap } from "../core/redis.js";
import { thumbnailObjectKey } from "../storage/image-paths.js";
import { checkS3Cors } from "../storage/cors.js";
import { backfillMissingMd5 } from "../jobs/maintenance.js";
import { migrateStorageBackend, type MigrateRow } from "../storage/migration.js";
import { copyObject, exists, listStorageKeys, removeObject } from "../storage/storage.js";
import { getAppSettings, getStorageConfig, type StorageBackend } from "../config/settings.js";

// Backends to inspect: every backend recorded on an image, plus the default.
async function storageBackends(rows: Array<{ storage_backend: StorageBackend }>) {
  const defaultBackend = (await getStorageConfig()).backend;
  return { defaultBackend, backends: [...new Set<StorageBackend>([defaultBackend, ...rows.map((row) => row.storage_backend)])] };
}

export function registerCheckRoutes(app: Hono) {
  app.post(`${adminApiBasePath}/check/db`, async (c) => {
    const categories = (await pool.query("SELECT c.category_key, c.count, COALESCE(m.count, 0)::int AS actual FROM category c LEFT JOIN (SELECT category_key, count(*) FROM metadata WHERE status='ready' GROUP BY category_key) m USING(category_key) ORDER BY c.category_key")).rows;
    const gaps = (await pool.query(`
      WITH ready AS (
        SELECT category_key, category_index, row_number() OVER (PARTITION BY category_key ORDER BY category_index) AS expected
        FROM metadata
        WHERE status='ready'
      )
      SELECT category_key, category_index, expected
      FROM ready
      WHERE category_index <> expected
      ORDER BY category_key, category_index
    `)).rows;
    const operations = (await pool.query("SELECT id,type,target_id,status,retry_count,error,updated_at FROM operation_log WHERE status IN ('pending','running','failed') ORDER BY updated_at DESC LIMIT 100")).rows;
    return c.json(ok({ categories, mismatches: categories.filter((row) => Number(row.count) !== Number(row.actual)), index_gaps: gaps, operations }));
  });

  app.post(`${adminApiBasePath}/check/redis`, async (c) => c.json(ok(await inspectRedisState())));

  app.post(`${adminApiBasePath}/check/storage`, async (c) => {
    const rows = (await pool.query("SELECT id, object_key, status, storage_backend FROM metadata")).rows as Array<{ id: string; object_key: string; status: string; storage_backend: StorageBackend }>;
    const { defaultBackend, backends } = await storageBackends(rows);
    const missingObjects: Array<Record<string, unknown>> = [];
    const missingThumbs: Array<Record<string, unknown>> = [];
    const missingTrash: Array<Record<string, unknown>> = [];
    const orphanObjects: Array<Record<string, unknown>> = [];
    const orphanThumbs: Array<Record<string, unknown>> = [];
    const orphanTrash: Array<Record<string, unknown>> = [];
    const unavailableBackends: string[] = [];
    let stagingFiles: string[] = [];
    // Each image is checked against the storage it actually lives in.
    for (const backend of backends) {
      try {
        const ready = rows.filter((row) => row.storage_backend === backend && row.status === "ready");
        const deleted = rows.filter((row) => row.storage_backend === backend && row.status === "deleted");
        const objectKeys = await listStorageKeys("objects", backend);
        const thumbKeys = await listStorageKeys("thumbs", backend);
        const trashKeys = await listStorageKeys("trash", backend);
        if (backend === defaultBackend) stagingFiles = await listStorageKeys("_uploads", backend);
        const objectSet = new Set(objectKeys);
        const thumbSet = new Set(thumbKeys);
        const trashSet = new Set(trashKeys);
        const readySet = new Set(ready.map((row) => row.object_key));
        const readyThumbSet = new Set(ready.map((row) => thumbnailObjectKey(row.object_key)));
        const deletedKeySet = new Set(deleted.map((row) => row.object_key));
        for (const image of ready) {
          if (!objectSet.has(image.object_key)) { missingObjects.push({ id: image.id, object_key: image.object_key, backend }); continue; }
          if (!thumbSet.has(thumbnailObjectKey(image.object_key))) missingThumbs.push({ id: image.id, object_key: image.object_key, thumb_key: thumbnailObjectKey(image.object_key), backend });
        }
        for (const image of deleted) {
          if (!trashSet.has(image.object_key)) missingTrash.push({ id: image.id, object_key: image.object_key, backend });
        }
        for (const key of objectKeys) if (!readySet.has(key)) orphanObjects.push({ key, backend });
        for (const key of thumbKeys) if (!readyThumbSet.has(key)) orphanThumbs.push({ key, backend });
        for (const key of trashKeys) if (!deletedKeySet.has(key)) orphanTrash.push({ key, backend });
      } catch (error) {
        unavailableBackends.push(`${backend}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return c.json(ok({
      missing_objects: missingObjects,
      missing_thumbs: missingThumbs,
      missing_trash: missingTrash,
      orphan_objects: orphanObjects,
      orphan_thumbs: orphanThumbs,
      orphan_trash: orphanTrash,
      staging_files: stagingFiles,
      unavailable_backends: unavailableBackends
    }));
  });

  app.post(`${adminApiBasePath}/check/storage-cleanup`, async (c) => {
    const rows = (await pool.query("SELECT object_key, status, storage_backend FROM metadata")).rows as Array<{ object_key: string; status: string; storage_backend: StorageBackend }>;
    const uploadRows = (await pool.query(
      "SELECT staging_object_key, final_object_key FROM upload_session WHERE status='finalizing' OR (status='created' AND expires_at >= now())"
    )).rows as Array<{ staging_object_key: string; final_object_key: string | null }>;
    const activeUploads = new Set(uploadRows.map((row) => String(row.staging_object_key)));
    const finalizingObjects = new Set(uploadRows.map((row) => row.final_object_key).filter((key): key is string => Boolean(key)));
    const { defaultBackend, backends } = await storageBackends(rows);
    const failures: Array<{ prefix: string; key: string; backend: string; error: string }> = [];
    let removed = 0;
    let candidateCount = 0;
    // Only objects unreferenced within their own backend are removed.
    for (const backend of backends) {
      try {
        const ready = new Set(rows.filter((row) => row.storage_backend === backend && row.status === "ready").map((row) => row.object_key));
        const deleted = new Set(rows.filter((row) => row.storage_backend === backend && row.status === "deleted").map((row) => row.object_key));
        const readyThumbs = new Set([...ready].map(thumbnailObjectKey));
        const candidates: Array<readonly ["objects" | "thumbs" | "trash" | "_uploads", string]> = [
          ...(await listStorageKeys("objects", backend)).filter((key) => !ready.has(key) && !finalizingObjects.has(key)).map((key) => ["objects", key] as const),
          ...(await listStorageKeys("thumbs", backend)).filter((key) => !readyThumbs.has(key)).map((key) => ["thumbs", key] as const),
          ...(await listStorageKeys("trash", backend)).filter((key) => !deleted.has(key)).map((key) => ["trash", key] as const),
          ...(backend === defaultBackend ? (await listStorageKeys("_uploads", backend)).filter((key) => !activeUploads.has(key.replace(/\.part$/, ""))).map((key) => ["_uploads", key] as const) : [])
        ];
        candidateCount += candidates.length;
        for (const [prefix, key] of candidates) {
          try {
            await removeObject(prefix, key, backend);
            removed += 1;
          } catch (error) {
            failures.push({ prefix, key, backend, error: error instanceof Error ? error.message : String(error) });
          }
        }
      } catch (error) {
        failures.push({ prefix: "*", key: "*", backend, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await invalidateImageReadCaches();
    return c.json(ok({ removed, candidates: candidateCount, failures }));
  });

  app.post(`${adminApiBasePath}/check/trash`, async (c) => {
    const rows = (await pool.query("SELECT id, object_key, deleted_at FROM metadata WHERE status='deleted' ORDER BY deleted_at ASC LIMIT $1", [appConfig.trashBatchSize])).rows;
    return c.json(ok({ deleted_count: rows.length, candidates: rows }));
  });

  app.post(`${adminApiBasePath}/check/all`, async (c) => {
    const dbCheck = (await pool.query("SELECT count(*)::int FROM metadata")).rows[0].count;
    const folderMap = await getFolderMap();
    const distinct = (await pool.query("SELECT DISTINCT storage_backend FROM metadata")).rows as Array<{ storage_backend: StorageBackend }>;
    const { defaultBackend, backends } = await storageBackends(distinct);
    const storage: Record<string, unknown> = {};
    for (const backend of backends) {
      try {
        storage[backend] = {
          objects: (await listStorageKeys("objects", backend)).length,
          thumbs: (await listStorageKeys("thumbs", backend)).length,
          trash: (await listStorageKeys("trash", backend)).length,
          uploads: (await listStorageKeys("_uploads", backend)).length
        };
      } catch (error) {
        storage[backend] = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    return c.json(ok({ images: dbCheck, default_backend: defaultBackend, folder_map: folderMap, storage }));
  });

  app.post(`${adminApiBasePath}/check/backfill-md5`, async (c) => {
    const result = await backfillMissingMd5();
    return c.json(ok({ backfilled: result.processed }));
  });

  app.post(`${adminApiBasePath}/check/cors`, async (c) => {
    const settings = await getAppSettings();
    const origin = `https://${settings.site.domain}`;
    return c.json(ok({ cors: await checkS3Cors(origin) }));
  });

  app.post(`${adminApiBasePath}/check/migrate-storage-location`, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const direction = body.direction === "s3-to-local" ? "s3-to-local" : body.direction === "local-to-s3" ? "local-to-s3" : "";
    if (!direction) throw new ApiError(400, "validation_error", "Invalid migration direction");
    const rows = (await pool.query("SELECT id, object_key, ext, status, storage_backend FROM metadata ORDER BY created_at ASC")).rows as MigrateRow[];
    const migration = await migrateStorageBackend(direction, rows);
    await invalidateImageReadCaches();
    return c.json(ok({ migration }));
  });

  app.post(`${adminApiBasePath}/check/migrate-storage-paths`, async (c) => {
    const rows = (await pool.query("SELECT id, object_key, device, brightness, theme, ext, status, storage_backend FROM metadata ORDER BY created_at ASC")).rows as Array<{
      id: string;
      object_key: string;
      device: string;
      brightness: string;
      theme: string;
      ext: string;
      status: string;
      storage_backend: StorageBackend;
    }>;
    let migrated = 0;
    let unchanged = 0;
    let missing = 0;
    let thumbs = 0;
    const errors: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const backend = row.storage_backend;
      const nextKey = storageObjectKey(row.device, row.brightness, row.theme, row.id, row.ext);
      if (row.object_key === nextKey) {
        unchanged += 1;
        continue;
      }
      let copiedObject = false;
      let copiedThumb = false;
      let databaseUpdated = false;
      try {
        const prefix = row.status === "deleted" ? "trash" : "objects";
        const oldObjectExists = await exists(prefix, row.object_key, backend);
        const newObjectExists = await exists(prefix, nextKey, backend);
        if (!oldObjectExists && !newObjectExists) {
          missing += 1;
          errors.push({ id: row.id, object_key: row.object_key, expected_key: nextKey, reason: "source_missing" });
          continue;
        }
        if (oldObjectExists && !newObjectExists) {
          await copyObject(prefix, row.object_key, prefix, nextKey, backend);
          copiedObject = true;
        }
        const oldThumbKey = thumbnailObjectKey(row.object_key);
        const nextThumbKey = thumbnailObjectKey(nextKey);
        if (row.status === "ready" && await exists("thumbs", oldThumbKey, backend)) {
          if (!(await exists("thumbs", nextThumbKey, backend))) {
            await copyObject("thumbs", oldThumbKey, "thumbs", nextThumbKey, backend);
            copiedThumb = true;
          }
          thumbs += 1;
        }
        const updated = await pool.query("UPDATE metadata SET object_key=$2, updated_at=now() WHERE id=$1 AND object_key=$3", [row.id, nextKey, row.object_key]);
        if (!updated.rowCount) throw new ApiError(409, "image_changed", "Image changed during path migration");
        databaseUpdated = true;
        if (oldObjectExists) await removeObject(prefix, row.object_key, backend).catch(() => undefined);
        if (row.status === "ready" && await exists("thumbs", oldThumbKey, backend)) {
          await removeObject("thumbs", oldThumbKey, backend).catch(() => undefined);
        }
        migrated += 1;
      } catch (error) {
        if (!databaseUpdated) {
          if (copiedObject) await removeObject(row.status === "deleted" ? "trash" : "objects", nextKey, backend).catch(() => undefined);
          if (copiedThumb) await removeObject("thumbs", thumbnailObjectKey(nextKey), backend).catch(() => undefined);
        }
        errors.push({ id: row.id, object_key: row.object_key, expected_key: nextKey, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    await rebuildFolderMap();
    await invalidateImageReadCaches();
    return c.json(ok({ migrated, unchanged, missing, thumbs, errors: errors.slice(0, 100), error_count: errors.length }));
  });
}
