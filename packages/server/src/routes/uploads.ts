import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ApiError, ok } from "../core/http.js";
import { linkDownloadCommitInput, parse, uploadCreateInput, uuidInput } from "../core/validation.js";
import { cancelPreparedImport, commitPreparedImport, createStoredUploadSession, getPreparedImportStatus, listPreparedImportStatuses, previewPreparedImport, receiveStoredUpload, streamPreparedImportEvents } from "../images/prepared-import/service.js";
import { isReservedSubdomain } from "../themes/host.js";

export function registerUploadRoutes(app: Hono) {
  app.post(`${adminApiBasePath}/uploads/create`, async (c) => {
    const input = parse(uploadCreateInput, await c.req.json().catch(() => ({})));
    return c.json(ok(await createStoredUploadSession(input)));
  });

  app.put(`${adminApiBasePath}/uploads/:id/file`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return c.json(ok(await receiveStoredUpload(id, c.req.raw.body)));
  });

  app.get(`${adminApiBasePath}/imports/:id/preview`, async (c) => {
    return previewPreparedImport(parse(uuidInput, c.req.param("id")));
  });

  app.get(`${adminApiBasePath}/imports/:id/status`, async (c) => {
    return c.json(ok(await getPreparedImportStatus(parse(uuidInput, c.req.param("id")))));
  });

  app.get(`${adminApiBasePath}/imports/status`, async (c) => {
    const ids = parseImportIds(c.req.url);
    return c.json(ok({ items: await listPreparedImportStatuses(ids) }));
  });

  app.get(`${adminApiBasePath}/imports/events`, async (c) => {
    return streamPreparedImportEvents(parseImportIds(c.req.url));
  });

  app.post(`${adminApiBasePath}/imports/:id/commit`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    const input = parse(linkDownloadCommitInput, { ...await c.req.json().catch(() => ({})), staging_id: id });
    if (isReservedSubdomain(input.theme)) throw new ApiError(400, "theme_reserved", "Theme conflicts with a reserved subdomain prefix", { theme: input.theme });
    const { staging_id: _stagingId, ...metadata } = input;
    return c.json(ok({ item: await commitPreparedImport(id, metadata) }));
  });

  app.post(`${adminApiBasePath}/imports/:id/cancel`, async (c) => {
    await cancelPreparedImport(parse(uuidInput, c.req.param("id")));
    return c.json(ok({ cancelled: true }));
  });
}

function parseImportIds(url: string) {
  return (new URL(url).searchParams.get("ids") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => parse(uuidInput, id));
}
