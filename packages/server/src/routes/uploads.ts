import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ok } from "../core/http.js";
import { parse, uploadCreateInput, uuidInput } from "../core/validation.js";
import { createUploadSession, finalizeUpload, writeUploadFile } from "../images/upload.js";

// Thin HTTP layer for the upload flow (create → PUT bytes → complete). All session
// and finalization logic lives in images/upload.ts.
export function registerUploadRoutes(app: Hono) {
  app.post(`${adminApiBasePath}/uploads/create`, async (c) => {
    const input = parse(uploadCreateInput, await c.req.json().catch(() => ({})));
    return c.json(ok(await createUploadSession(input)));
  });

  app.put(`${adminApiBasePath}/uploads/:id/file`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    await writeUploadFile(id, c.req.raw.body);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/uploads/:id/complete`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    return c.json(ok({ item: await finalizeUpload(id) }));
  });
}
