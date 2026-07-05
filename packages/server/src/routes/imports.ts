import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ApiError, ok } from "../core/http.js";
import { importCommitInput, importCreateInput, parse, uuidInput } from "../core/validation.js";
import { cancelImportSession, commitImportSession, createImportSession, getImportStatus, listImportStatuses, prepareImportSession, previewImportSession, receiveImportFile, streamImportEvents } from "../images/imports/service.js";
import { isReservedSubdomain } from "../themes/host.js";

export function registerImportRoutes(app: Hono) {
  app.post(`${adminApiBasePath}/imports/create`, async (c) => {
    const input = parse(importCreateInput, await c.req.json().catch(() => ({})));
    return c.json(ok(await createImportSession(input)));
  });

  app.put(`${adminApiBasePath}/imports/:id/file`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    const body = c.req.raw.body ?? new Response(await c.req.arrayBuffer()).body;
    return c.json(ok(await receiveImportFile(id, body, c.req.raw.signal)));
  });

  app.post(`${adminApiBasePath}/imports/:id/prepare`, async (c) => {
    return c.json(ok(await prepareImportSession(parse(uuidInput, c.req.param("id")))));
  });

  app.get(`${adminApiBasePath}/imports/:id/preview/full`, async (c) => {
    return previewImportSession(parse(uuidInput, c.req.param("id")), "full");
  });

  app.get(`${adminApiBasePath}/imports/:id/preview`, async (c) => {
    return previewImportSession(parse(uuidInput, c.req.param("id")), "thumb");
  });

  app.get(`${adminApiBasePath}/imports/:id/status`, async (c) => {
    return c.json(ok(await getImportStatus(parse(uuidInput, c.req.param("id")))));
  });

  app.get(`${adminApiBasePath}/imports/status`, async (c) => {
    const ids = parseImportIds(c.req.url);
    return c.json(ok({ items: await listImportStatuses(ids) }));
  });

  app.get(`${adminApiBasePath}/imports/events`, async (c) => {
    return streamImportEvents(parseImportIds(c.req.url));
  });

  app.post(`${adminApiBasePath}/imports/:id/commit`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    const input = parse(importCommitInput, await c.req.json().catch(() => ({})));
    if (isReservedSubdomain(input.theme)) throw new ApiError(400, "theme_reserved", "Theme conflicts with a reserved subdomain prefix", { theme: input.theme });
    return c.json(ok(await commitImportSession(id, input)));
  });

  app.post(`${adminApiBasePath}/imports/:id/cancel`, async (c) => {
    await cancelImportSession(parse(uuidInput, c.req.param("id")));
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
