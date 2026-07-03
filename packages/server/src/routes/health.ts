import type { Context, Hono } from "hono";
import { pool, pingDb } from "../core/db.js";
import { fail, noStoreCacheControl, routeError } from "../core/http.js";
import { pingRedis } from "../core/redis-client.js";

export function registerHealthRoutes(app: Hono) {
  app.all("/livez", async (c) => {
    if (c.req.method !== "GET") return routeError({ status: 405, message: "Method Not Allowed" });
    c.header("Cache-Control", noStoreCacheControl);
    return c.json({ message: "ImageShow process is alive", ok: true, status: "alive" });
  });

  app.all("/readyz", readinessHandler);
}

async function readinessHandler(c: Context) {
  if (c.req.method !== "GET") return routeError({ status: 405, message: "Method Not Allowed" });
  if (new URL(c.req.url).search) return routeError({ status: 403, message: "Forbidden: Query parameters are not allowed on this route" });
  try {
    await pingDb();
    await pingRedis();
    await Promise.all([
      pool.query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"),
      pool.query("SELECT 1")
    ]);
    c.header("Cache-Control", noStoreCacheControl);
    return c.json({ message: "ImageShow is healthy", ok: true, status: "healthy" });
  } catch (error) {
    return fail(c, error);
  }
}
