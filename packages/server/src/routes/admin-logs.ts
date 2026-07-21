import type { Context, Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ApiError } from "../core/api-error.ts";
import { clientIp, ok, requireSuper } from "../core/http.ts";
import { readRecentLogFile, updateLogLevel } from "../core/log-files.ts";
import { logger } from "../core/logger.ts";

function boundedText(value: unknown, maximumLength: number) {
  return typeof value === "string"
    ? value.trim().slice(0, maximumLength)
    : "";
}

function adminSession(c: Context) {
  return c.get("session") as {
    username?: string;
    role?: string;
  } | undefined;
}

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

  app.post(`${adminApiBasePath}/logs/client-errors`, async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const context = boundedText(body.context, 120);
    const message = boundedText(body.message, 2_000);
    if (!context || !message) {
      throw new ApiError(400, "invalid_client_error", "错误日志缺少上下文或错误消息");
    }

    const session = adminSession(c);
    logger.error("admin_ui_error", {
      actor: session?.username ?? "unknown",
      role: session?.role ?? "unknown",
      context,
      error_name: boundedText(body.name, 120),
      message,
      stack: boundedText(body.stack, 8_000),
      details: boundedText(body.details, 2_000),
      page_path: boundedText(body.page_path, 500),
      user_agent: boundedText(c.req.header("user-agent"), 500),
      ip: clientIp(c)
    });
    return c.json(ok());
  });
}
