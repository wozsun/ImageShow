import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ok } from "../core/http.ts";
import { batchImageUpdatePath, limitBatchImageUpdateBody } from "../core/request-body-limit.ts";
import {
  adminImageListQuery,
  batchImageUpdateInput,
  batchMigrateStorageInput,
  imageIdsInput,
  parse,
  uuidInput,
} from "../core/validation.ts";
import { batchDeleteImages } from "../images/batch-delete.ts";
import {
  getAdminImage,
  getAdminImageInfo,
  listAdminImages
} from "../images/read-models/admin-images.ts";
import { getOverviewStats } from "../images/read-models/overview.ts";
import { serveAdminObject, serveAdminOriginalLink, serveAdminThumb } from "../images/serving.ts";
import { deleteImage, migrateImagesStorage, updateImageMetadata } from "../images/service.ts";
import { batchRestoreImages, purgeDeletedImage, purgeDeletedImages, restoreDeletedImage } from "../images/trash.ts";
import { setImageTags } from "../tags/service.ts";
import { createEntityCountCacheInvalidationBatch } from "../vocab/vocab-cache.ts";

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
    const input = parse(batchMigrateStorageInput, await c.req.json().catch(() => ({})));
    return c.json(ok(await migrateImagesStorage(input.ids, input.target)));
  });

  app.post(batchImageUpdatePath, limitBatchImageUpdateBody, async (c) => {
    const input = parse(batchImageUpdateInput, await c.req.json().catch(() => ({})));
    const entityCountInvalidationBatch = createEntityCountCacheInvalidationBatch();
    let updated = 0;
    try {
      for (const item of input.items) {
        const { id, tags, ...metadata } = item;
        const metadataChanged = Object.keys(metadata).length > 0;
        if (!metadataChanged && tags === undefined) continue;
        if (metadataChanged) {
          await updateImageMetadata(id, metadata, { entityCountInvalidationBatch });
        }
        if (tags !== undefined) {
          await setImageTags(id, tags, { entityCountInvalidationBatch });
        }
        updated += 1;
      }
    } finally {
      await entityCountInvalidationBatch.flush();
    }
    return c.json(ok({ updated }));
  });

  app.post(`${adminApiBasePath}/images/:id`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return c.json(ok({ item: await updateImageMetadata(id, await c.req.json().catch(() => ({}))) }));
  });
}
