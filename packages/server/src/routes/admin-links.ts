import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ApiError, ok } from "../core/http.js";
import { linkCommitInput, linkDownloadPrepareInput, linkPrepareInput, parse, uuidInput } from "../core/validation.js";
import { isReservedSubdomain } from "../themes/host.js";
import { cancelLinkImage, commitLinkImage, prepareLinkImage, previewLinkImage } from "../images/link-import/proxy.js";
import { createDownloadedImportSession, prepareDownloadedImage } from "../images/link-import/download.js";

export function registerAdminLinkRoutes(app: Hono) {
  app.post(`${adminApiBasePath}/import-links/prepare`, async (c) => {
    const input = parse(linkPrepareInput, await c.req.json().catch(() => ({})));
    return c.json(ok(await prepareLinkImage(input.url, input.staging_id, input.storage_slug)));
  });
  app.post(`${adminApiBasePath}/import-links/:id/cancel`, async (c) => {
    await cancelLinkImage(parse(uuidInput, c.req.param("id")));
    return c.json(ok({ cancelled: true }));
  });

  app.get(`${adminApiBasePath}/import-links/:id/preview`, async (c) => previewLinkImage(parse(uuidInput, c.req.param("id"))));

  app.post(`${adminApiBasePath}/import-links/commit`, async (c) => {
    const input = parse(linkCommitInput, await c.req.json().catch(() => ({})));
    if (isReservedSubdomain(input.theme)) throw new ApiError(400, "theme_reserved", "Theme conflicts with a reserved subdomain prefix", { theme: input.theme });
    return c.json(ok(await commitLinkImage(input)));
  });

  app.post(`${adminApiBasePath}/import-links/download/create`, async (c) => {
    const input = parse(linkDownloadPrepareInput, await c.req.json().catch(() => ({})));
    return c.json(ok(await createDownloadedImportSession(input)));
  });
  app.post(`${adminApiBasePath}/import-links/download/:id/prepare`, async (c) => {
    return c.json(ok(await prepareDownloadedImage(parse(uuidInput, c.req.param("id")))));
  });
}
