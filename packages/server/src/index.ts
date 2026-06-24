import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { env } from "./config/env.js";
import { initializeAdmin, pingDb, pool, runMigrations } from "./core/db.js";
import { pingRedis, redis } from "./core/redis.js";
import { ensureStorage } from "./storage/storage.js";
import { fail, requireAuth, requireCsrf, routeError } from "./core/http.js";
import { registerAdminImageRoutes } from "./routes/admin-images.js";
import { registerCheckRoutes } from "./routes/check.js";
import { registerDocsRoutes } from "./routes/docs.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProtectedAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.js";
import { registerPublicRoutes } from "./routes/public.js";
import { handleRandomImage, registerRandomRoutes } from "./routes/random.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerStaticRoutes } from "./routes/spa.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { startWorker, stopWorker } from "./jobs/tasks.js";
import { enforceThemeHostNavigation, specialHost } from "./core/theme-host.js";

const app = new Hono();

app.onError((error, c) => fail(c, error));
app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Content-Security-Policy", "frame-ancestors 'none'");
  await next();
});
app.options("*", async () => new Response(null, { status: 204 }));
// docs.<domain> serves the bundled VitePress site and short-circuits the rest of
// the app (registered before the other host middleware on purpose).
registerDocsRoutes(app);
// Host-based access control for the reserved subdomains:
//   random.<domain> → the random API only, at "/" with GET/HEAD; everything else 404.
//   static.<domain> → object bytes only, under /media/* and /thumbs/*; else 404.
app.use("*", async (c, next) => {
  const special = specialHost(c.req.header("host") ?? "");
  if (special === "random") {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return routeError({ status: 405, message: "Method Not Allowed" });
    if (new URL(c.req.url).pathname !== "/") return routeError({ status: 404, message: "Not Found" });
    return handleRandomImage(c);
  }
  if (special === "static") {
    const path = new URL(c.req.url).pathname;
    if (!path.startsWith("/media/") && !path.startsWith("/thumbs/")) return routeError({ status: 404, message: "Not Found" });
  }
  return next();
});
// Object bytes are exposed only on the cookie-isolated static.<domain> host; the
// main and theme hosts never serve /media or /thumbs.
const mediaHostGuard = async (c: Parameters<typeof enforceThemeHostNavigation>[0], next: Parameters<typeof enforceThemeHostNavigation>[1]) => {
  if (specialHost(c.req.header("host") ?? "") === "static") return next();
  return routeError({ status: 404, message: "Not Found" });
};
app.use("/media/*", mediaHostGuard);
app.use("/thumbs/*", mediaHostGuard);
app.use("*", enforceThemeHostNavigation);

registerHealthRoutes(app);
registerPublicRoutes(app);
registerRandomRoutes(app);
registerPublicAuthRoutes(app);

app.use(`${adminApiBasePath}/*`, requireAuth);
registerProtectedAuthRoutes(app);
app.use(`${adminApiBasePath}/*`, async (c, next) => {
  if (c.req.method !== "GET") return requireCsrf(c, next);
  await next();
});

registerAdminImageRoutes(app);
registerUploadRoutes(app);
registerSettingsRoutes(app);
registerCheckRoutes(app);
registerStaticRoutes(app);

await ensureStorage();
await pingDb();
await runMigrations();
await initializeAdmin();
await pingRedis();
startWorker();

const server = serve({ fetch: app.fetch, port: env.PORT });
console.log(`ImageShow listening on :${env.PORT}`);

process.on("SIGTERM", () => {
  stopWorker();
  server.close();
  redis.disconnect();
  void pool.end();
});
