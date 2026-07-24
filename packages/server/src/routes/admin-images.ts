import type { Hono } from "hono";
import {
  adminApiBasePath,
  adminPermissions,
  type BatchImageUpdateResponse
} from "@imageshow/shared";
import { apiSuccess } from "../core/http/responses.ts";
import { logger } from "../core/logger.ts";
import {
  batchImageUpdatePath,
  getRequestBodyBytes,
  limitBatchImageUpdateBody,
} from "../core/http/request-body-limit.ts";
import {
  adminImageListQuery,
  batchImageUpdateInput,
  batchMigrateStorageInput,
  imageIdsInput,
  parse,
  uuidInput,
} from "../core/validation.ts";
import { batchDeleteImages } from "../images/batch-delete.ts";
import { migrateImageBatchStorage } from "../images/batch-storage-migration.ts";
import { updateImagesBatch } from "../images/batch-update.ts";
import {
  getAdminImageInfo,
  listAdminImages
} from "../images/read-models/admin-images.ts";
import { getOverviewStats } from "../images/read-models/overview.ts";
import { serveAdminObject, serveAdminOriginalLink, serveAdminThumb } from "../images/serving.ts";
import {
  batchRestoreImages,
  moveImageToTrash,
  purgeDeletedImage,
  purgeDeletedImages,
  restoreDeletedImage
} from "../images/trash.ts";
import { scheduleTrashPurge } from "../images/trash-purge-job.ts";
import { requireAdminPermission } from "../users/admin-authorization.ts";

export function registerAdminImageRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/overview`, async (c) => c.json(apiSuccess(await getOverviewStats())));

  app.get(`${adminApiBasePath}/images`, async (c) => {
    const q = parse(adminImageListQuery, Object.fromEntries(new URL(c.req.url).searchParams));
    return c.json(apiSuccess(await listAdminImages(q)));
  });

  app.get(`${adminApiBasePath}/images/:id/admin-info`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return c.json(apiSuccess(await getAdminImageInfo(id)));
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
    await moveImageToTrash(id);
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/images/:id/restore`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    await restoreDeletedImage(id);
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/images/batch-restore`, async (c) => {
    const input = parse(imageIdsInput, await c.req.json().catch(() => ({})));
    return c.json(apiSuccess(await batchRestoreImages(input.ids)));
  });

  app.post(`${adminApiBasePath}/images/batch-delete`, async (c) => {
    const input = parse(imageIdsInput, await c.req.json().catch(() => ({})));
    return c.json(apiSuccess(await batchDeleteImages(input.ids)));
  });

  app.post(
    `${adminApiBasePath}/images/empty-trash`,
    requireAdminPermission(adminPermissions.imageTrashEmpty),
    async (c) => {
      const result = await purgeDeletedImages();
      if (result.remaining) await scheduleTrashPurge();
      return c.json(apiSuccess({
        deleted: result.deleted,
        failed: result.failed,
        remaining: result.remaining
      }));
    }
  );

  app.post(
    `${adminApiBasePath}/images/:id/purge`,
    requireAdminPermission(adminPermissions.imageTrashPurge),
    async (c) => {
      const id = parse(uuidInput, c.req.param("id"));
      await purgeDeletedImage(id);
      return c.json(apiSuccess());
    }
  );

  app.post(
    `${adminApiBasePath}/images/batch-migrate-storage`,
    requireAdminPermission(adminPermissions.imageStorageMigrate),
    async (c) => {
      const startedAt = performance.now();
      const input = parse(batchMigrateStorageInput, await c.req.json().catch(() => ({})));
      let maxItemDurationMs = 0;
      let randomPoolFullRebuildTriggered = false;
      const result = await migrateImageBatchStorage(input.ids, input.target, {
        onMetrics(metrics) {
          maxItemDurationMs = metrics.maxImageDurationMs;
          randomPoolFullRebuildTriggered = metrics.randomPoolFullRebuildTriggered;
        },
      });
      logger.info("batch_storage_migration_summary", {
        requested: result.requested,
        succeeded: result.succeeded,
        failed: result.failed,
        total_duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
        max_item_duration_ms: Math.round(maxItemDurationMs * 100) / 100,
        request_body_bytes: getRequestBodyBytes(c),
        entity_count_invalidation_triggered: false,
        random_pool_full_rebuild_triggered: randomPoolFullRebuildTriggered,
      });
      return c.json(apiSuccess({
        migrated: result.migrated,
        failed: result.failed,
      }));
    }
  );

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
      requested: input.items.length,
      succeeded: result.updated,
      failed: result.failed,
      total_duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
      max_item_duration_ms: Math.round(maxItemDurationMs * 100) / 100,
      request_body_bytes: getRequestBodyBytes(c),
      entity_count_invalidation_triggered: entityCountInvalidationTriggered,
      random_pool_full_rebuild_triggered: randomPoolFullRebuildTriggered,
    });
    const response = {
      updated: result.updated,
      failed: result.failed,
      results: result.results
    } satisfies BatchImageUpdateResponse;
    return c.json(apiSuccess(response));
  });
}
