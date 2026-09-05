import type { Hono } from "hono";
import {
  adminApiBasePath,
  adminImageListReadStartedAtHeader,
  adminPermissions,
  type ImagePurgeResponseDto,
  type ImageRestoreResponseDto,
  type ImageSnapshotResponseDto,
  type ImageStorageMigrationResponseDto,
  type ImageTrashResponseDto,
  type ImageUpdateRequestDto,
  type ImageUpdateResponseDto
} from "@imageshow/shared/browser";
import {
  apiSuccess,
  privateCacheableApiSuccess
} from "../core/http/responses.ts";
import { readJsonBody } from "../core/http/json-body.ts";
import { logger } from "../core/logger.ts";
import {
  imageUpdatePath,
  getRequestBodyBytes,
  limitImageUpdateBody,
} from "../core/http/request-body-limit.ts";
import {
  adminImageListQuery,
  imageActionInput,
  imagePurgeInput,
  imageSnapshotInput,
  imageStorageMigrationInput,
  imageUpdateInput,
} from "./validation/images.ts";
import { parse } from "./validation/parse.ts";
import { uuidInput } from "./validation/primitives.ts";
import {
  migrateSelectedImagesToStorageBackend
} from "../images/storage-location/selected-images-migration.ts";
import { updateImages } from "../images/image-update.ts";
import {
  getAdminImageSnapshots,
  getAdminImageInfo,
  listAdminImages
} from "../images/read-models/admin-images.ts";
import { getOverviewStats } from "../images/read-models/overview.ts";
import { serveAdminExternalOriginal } from "../images/external-original-serving.ts";
import {
  moveImagesToTrash,
  restoreImages
} from "../images/trash-mutations.ts";
import { purgeImages } from "../images/trash-purge.ts";
import { requireAdminPermission } from "../users/admin-authorization.ts";
import { listStorageBackends } from "../storage/backends/registry.ts";
import { storageBackendLabel } from "../storage/backends/label.ts";

export function registerAdminImageRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/overview`, async (c) => c.json(apiSuccess(await getOverviewStats())));

  app.get(`${adminApiBasePath}/images`, async (c) => {
    c.header(adminImageListReadStartedAtHeader, String(Date.now()));
    const q = parse(adminImageListQuery, Object.fromEntries(new URL(c.req.url).searchParams));
    return privateCacheableApiSuccess(c, await listAdminImages(q));
  });

  app.post(`${adminApiBasePath}/images/snapshot`, async (c) => {
    const input = parse(imageSnapshotInput, await readJsonBody(c));
    const response: ImageSnapshotResponseDto =
      await getAdminImageSnapshots(input.ids);
    return c.json(apiSuccess(response));
  });

  app.get(`${adminApiBasePath}/images/:id/admin-info`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return privateCacheableApiSuccess(c, await getAdminImageInfo(id));
  });

  app.get(`${adminApiBasePath}/images/:id/original`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return serveAdminExternalOriginal(id, c.req.header("user-agent") ?? "", c.req.raw.signal);
  });

  app.post(`${adminApiBasePath}/images/trash`, async (c) => {
    const input = parse(imageActionInput, await readJsonBody(c));
    const response: ImageTrashResponseDto = await moveImagesToTrash(input.ids);
    return c.json(apiSuccess(response));
  });

  app.post(`${adminApiBasePath}/images/restore`, async (c) => {
    const input = parse(imageActionInput, await readJsonBody(c));
    const response: ImageRestoreResponseDto = await restoreImages(input.ids);
    return c.json(apiSuccess(response));
  });

  app.post(
    `${adminApiBasePath}/images/purge`,
    requireAdminPermission(adminPermissions.imageTrashPurge),
    async (c) => {
      const input = parse(imagePurgeInput, await readJsonBody(c));
      const response: ImagePurgeResponseDto = await purgeImages(input, {
        signal: c.req.raw.signal
      });
      return c.json(apiSuccess(response));
    }
  );

  app.post(
    `${adminApiBasePath}/images/migrate-storage`,
    requireAdminPermission(adminPermissions.imageStorageMigrate),
    async (c) => {
      const startedAt = performance.now();
      const input = parse(imageStorageMigrationInput, await readJsonBody(c));
      const targetBackend = (await listStorageBackends()).find(
        (backend) => backend.slug === input.target
      );
      const targetStorageLabel = storageBackendLabel({
        storage_slug: input.target,
        storage_display_name: targetBackend?.display_name
      });
      let maxItemDurationMs = 0;
      const result = await migrateSelectedImagesToStorageBackend(input.ids, input.target, {
        signal: c.req.raw.signal,
        onMetrics(metrics) {
          maxItemDurationMs = metrics.maxImageDurationMs;
        },
      });
      logger.info("image_storage_migration_summary", {
        requested: result.requested,
        succeeded: result.succeeded,
        failed: result.failed,
        total_duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
        max_item_duration_ms: Math.round(maxItemDurationMs * 100) / 100,
        request_body_bytes: getRequestBodyBytes(c),
        entity_count_invalidation_triggered: false,
      });
      const response = {
        migrated: result.migrated,
        failed: result.failed,
        storage_label: targetStorageLabel,
        results: result.results
      } satisfies ImageStorageMigrationResponseDto;
      return c.json(apiSuccess(response));
    }
  );

  app.post(imageUpdatePath, limitImageUpdateBody, async (c) => {
    const startedAt = performance.now();
    const input = parse(
      imageUpdateInput,
      await readJsonBody(c)
    ) satisfies ImageUpdateRequestDto;
    let maxItemDurationMs = 0;
    let entityCountInvalidationTriggered = false;
    const result = await updateImages(input.items, {
      onMetrics(metrics) {
        maxItemDurationMs = metrics.maxItemDurationMs;
        entityCountInvalidationTriggered = metrics.entityCountInvalidationTriggered;
      },
    });
    logger.info("image_update_summary", {
      requested: input.items.length,
      succeeded: result.updated,
      failed: result.failed,
      total_duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
      max_item_duration_ms: Math.round(maxItemDurationMs * 100) / 100,
      request_body_bytes: getRequestBodyBytes(c),
      entity_count_invalidation_triggered: entityCountInvalidationTriggered,
    });
    const response = {
      updated: result.updated,
      failed: result.failed,
      results: result.results
    } satisfies ImageUpdateResponseDto;
    return c.json(apiSuccess(response));
  });
}
