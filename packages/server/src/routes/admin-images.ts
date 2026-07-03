import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ok } from "../core/http.js";
import { adminImageListQuery, batchMigrateStorageInput, imageIdsInput, md5Input, parse, uuidInput } from "../core/validation.js";
import { batchDeleteImages } from "../images/batch.js";
import { checkImageMd5, getAdminImage, getOverviewStats, listAdminImages } from "../images/query.js";
import { serveAdminObject, serveAdminOriginalLink, serveAdminThumb } from "../images/serving.js";
import { deleteImage, migrateImagesStorage, updateImageMetadata } from "../images/service.js";
import { batchRestoreImages, purgeDeletedImage, purgeDeletedImages, restoreDeletedImage } from "../images/trash.js";

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

  app.get(`${adminApiBasePath}/images/:id/thumb`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return serveAdminThumb(id);
  });

  app.get(`${adminApiBasePath}/images/:id/raw`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return serveAdminObject(id);
  });

  app.get(`${adminApiBasePath}/images/:id/original`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return serveAdminOriginalLink(id, c.req.header("user-agent") ?? "");
  });

  app.post(`${adminApiBasePath}/images/check-md5`, async (c) => {
    const input = parse(md5Input, await c.req.json().catch(() => ({})));
    return c.json(ok(await checkImageMd5(input.md5)));
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

  app.post(`${adminApiBasePath}/images/:id`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return c.json(ok({ item: await updateImageMetadata(id, await c.req.json().catch(() => ({}))) }));
  });
}
