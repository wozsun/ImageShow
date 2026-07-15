import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ok } from "../core/http.ts";
import { logger } from "../core/logger.ts";
import {
  batchImageUpdatePath,
  getRequestBodyBytes,
  limitBatchImageUpdateBody,
} from "../core/request-body-limit.ts";
import {
  adminImageListQuery,
  batchImageUpdateInput,
  batchMigrateStorageInput,
  imageIdsInput,
  parse,
  uuidInput,
} from "../core/validation.ts";
import { batchDeleteImages } from "../images/batch-delete.ts";
import { updateImagesBatch } from "../images/batch-update.ts";
import {
  getAdminImage,
  getAdminImageInfo,
  listAdminImages
} from "../images/read-models/admin-images.ts";
import { getOverviewStats } from "../images/read-models/overview.ts";
import { serveAdminObject, serveAdminOriginalLink, serveAdminThumb } from "../images/serving.ts";
import { deleteImage, migrateImagesStorage, updateImageMetadata } from "../images/service.ts";
import { batchRestoreImages, purgeDeletedImage, purgeDeletedImages, restoreDeletedImage } from "../images/trash.ts";

export function registerAdminImageRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/overview`, async (c) => c.json(ok(await getOverviewStats())));

  app.get(`${adminApiBasePath}/images`, async (c) => {
    const q = parse(adminImageListQuery, Object.fromEntries(new URL(c.req.url).searchParams));
    return c.json(ok(await listAdminImages(q)));
  });

  app.get(`${adminApiBasePath}/images/:id`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return c.json(ok({ item: await getAdminImage(id) }));
  });

  app.get(`${adminApiBasePath}/images/:id/admin-info`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return c.json(ok(await getAdminImageInfo(id)));
  });

  app.get(`${adminApiBasePath}/images/:id/thumb`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return serveAdminThumb(id, {
      range: c.req.header("range"),
      ifNoneMatch: c.req.header("if-none-match"),
      ifRange: c.req.header("if-range"),
      isHead: c.req.method === "HEAD"
    });
  });

  app.get(`${adminApiBasePath}/images/:id/raw`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return serveAdminObject(id, {
      range: c.req.header("range"),
      ifNoneMatch: c.req.header("if-none-match"),
      ifRange: c.req.header("if-range"),
      isHead: c.req.method === "HEAD"
    });
  });

  app.get(`${adminApiBasePath}/images/:id/original`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return serveAdminOriginalLink(id, c.req.header("user-agent") ?? "");
  });

  app.post(`${adminApiBasePath}/images/:id/delete`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    await deleteImage(id);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/images/:id/restore`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    await restoreDeletedImage(id);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/images/batch-restore`, async (c) => {
    const input = parse(imageIdsInput, await c.req.json().catch(() => ({})));
    return c.json(ok(await batchRestoreImages(input.ids)));
  });

  app.post(`${adminApiBasePath}/images/batch-delete`, async (c) => {
    const input = parse(imageIdsInput, await c.req.json().catch(() => ({})));
    return c.json(ok(await batchDeleteImages(input.ids)));
  });

  app.post(`${adminApiBasePath}/images/empty-trash`, async (c) => c.json(ok(await purgeDeletedImages())));

  app.post(`${adminApiBasePath}/images/:id/purge`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return c.json(ok(await purgeDeletedImage(id)));
  });

  app.post(`${adminApiBasePath}/images/batch-migrate-storage`, async (c) => {
    const startedAt = performance.now();
    const input = parse(batchMigrateStorageInput, await c.req.json().catch(() => ({})));
    let maxItemDurationMs = 0;
    let randomPoolFullRebuildTriggered = false;
    const result = await migrateImagesStorage(input.ids, input.target, {
      onMetrics(metrics) {
        maxItemDurationMs = metrics.maxItemDurationMs;
        randomPoolFullRebuildTriggered = metrics.randomPoolFullRebuildTriggered;
      },
    });
    logger.info("batch_storage_migration_summary", {
      requested: result.requested,
      succeeded: result.migrated + result.unchanged,
      failed: result.failed,
      total_duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
      max_item_duration_ms: Math.round(maxItemDurationMs * 100) / 100,
      request_body_bytes: getRequestBodyBytes(c),
      entity_count_invalidation_triggered: false,
      random_pool_full_rebuild_triggered: randomPoolFullRebuildTriggered,
    });
    return c.json(ok(result));
  });

  app.post(batchImageUpdatePath, limitBatchImageUpdateBody, async (c) => {
    const startedAt = performance.now();
    const input = parse(batchImageUpdateInput, await c.req.json().catch(() => ({})));
    let maxItemDurationMs = 0;
    let entityCountInvalidationTriggered = false;
    let randomPoolFullRebuildTriggered = false;
    const result = await updateImagesBatch(input.items, {
      onMetrics(metrics) {
        maxItemDurationMs = metrics.maxItemDurationMs;
        entityCountInvalidationTriggered = metrics.entityCountInvalidationTriggered;
        randomPoolFullRebuildTriggered = metrics.randomPoolFullRebuildTriggered;
      },
    });
    logger.info("batch_image_update_summary", {
      requested: result.requested,
      succeeded: result.updated,
      failed: result.failed,
      total_duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
      max_item_duration_ms: Math.round(maxItemDurationMs * 100) / 100,
      request_body_bytes: getRequestBodyBytes(c),
      entity_count_invalidation_triggered: entityCountInvalidationTriggered,
      random_pool_full_rebuild_triggered: randomPoolFullRebuildTriggered,
    });
    return c.json(ok(result));
  });

  app.post(`${adminApiBasePath}/images/:id`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return c.json(ok({ item: await updateImageMetadata(id, await c.req.json().catch(() => ({}))) }));
  });
}
