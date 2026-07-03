import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ok, requireSuper } from "../core/http.js";
import { readRecentLogFile, updateLogLevel } from "../core/log-files.js";

export function registerAdminLogRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/logs`, requireSuper, async (c) => {
    const url = new URL(c.req.url);
    return c.json(ok(await readRecentLogFile({
      file: url.searchParams.get("file"),
      limit: url.searchParams.get("limit")
    })));
  });

  app.post(`${adminApiBasePath}/logs/level`, requireSuper, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(ok(updateLogLevel(String(body.level ?? ""))));
  });
}
