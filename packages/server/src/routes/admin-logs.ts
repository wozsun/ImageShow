import type { Context, Hono } from "hono";
import { z } from "zod";
import { adminApiBasePath } from "@imageshow/shared/browser";
import { apiSuccess } from "../core/http/responses.ts";
import { readJsonBody } from "../core/http/json-body.ts";
import { requestLogContext } from "../core/http/request-security.ts";
import { requireSuperAdmin } from "../users/admin-authorization.ts";
import { readRecentLogFile, updateLogLevel } from "../core/log-files.ts";
import { logger } from "../core/logger.ts";
import { parse } from "./validation/parse.ts";

const logLevelInput = z.strictObject({
  level: z.string()
});
const clientErrorInput = z.strictObject({
  context: z.string().trim().min(1).max(120),
  error: z.unknown(),
  metadata: z.unknown().optional()
});

function adminSession(c: Context) {
  return c.get("session") as
    | {
        username?: string;
        role?: string;
      }
    | undefined;
}

export function registerAdminLogRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/logs`, requireSuperAdmin, async (c) => {
    const url = new URL(c.req.url);
    return c.json(
      apiSuccess(
        await readRecentLogFile({
          file: url.searchParams.get("file"),
          limit: url.searchParams.get("limit")
        })
      )
    );
  });

  app.post(`${adminApiBasePath}/logs/level`, requireSuperAdmin, async (c) => {
    const body = parse(logLevelInput, await readJsonBody(c));
    return c.json(apiSuccess(await updateLogLevel(body.level)));
  });

  app.post(`${adminApiBasePath}/logs/client-errors`, async (c) => {
    const body = parse(clientErrorInput, await readJsonBody(c));
    const session = adminSession(c);
    logger.error("admin_ui_error", {
      ...requestLogContext(c),
      actor: session?.username ?? "unknown",
      role: session?.role ?? "unknown",
      context: body.context,
      error: body.error,
      metadata: body.metadata
    });
    return c.json(apiSuccess());
  });
}
