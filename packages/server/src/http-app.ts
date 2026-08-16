import { Hono, type Context, type Next } from "hono";
import { compress } from "hono/compress";
import { adminApiBasePath } from "@imageshow/shared/browser";
import { getRuntimeConfig } from "./config/runtime-config-store.ts";
import { apiErrorResponse, handleApiError } from "./core/http/responses.ts";
import {
  appendVaryHeader,
  finalizeSecurityHeaders,
  noStoreCacheControl
} from "./core/http/headers.ts";
import {
  requireAdminCsrf,
  requireAdminSession
} from "./users/admin-session.ts";
import {
  limitApiRequestBody,
  limitProtectedAdminRequestBody
} from "./core/http/request-body-limit.ts";
import { prepareCompressionThreshold } from "./core/http/compression-threshold.ts";
import { registerAdminLogRoutes } from "./routes/admin-logs.ts";
import { registerAdvancedConfigRoutes } from "./routes/advanced-config.ts";
import { registerAdminImageRoutes } from "./routes/admin-images.ts";
import { registerAdminTagRoutes } from "./routes/admin-tags.ts";
import { registerAdminThemeRoutes } from "./routes/admin-themes.ts";
import { registerAdminAuthorRoutes } from "./routes/admin-authors.ts";
import { registerAdminUserRoutes } from "./routes/admin-users.ts";
import { registerAdminPreferenceRoutes } from "./routes/admin-preferences.ts";
import { registerAdminCacheRoutes } from "./routes/admin-cache.ts";
import { registerCheckRoutes } from "./routes/check.ts";
import { registerHealthRoutes } from "./routes/health.ts";
import {
  registerProtectedAuthRoutes,
  registerPublicAuthRoutes
} from "./routes/auth.ts";
import { registerPublicRoutes } from "./routes/public.ts";
import { serveRobotsTxt } from "./routes/robots.ts";
import { registerRandomRoutes } from "./routes/random.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { registerSecurityReportRoutes } from "./routes/security-reports.ts";
import { registerStorageRoutes } from "./routes/storage.ts";
import { registerSpaRoutes } from "./routes/spa.ts";
import { registerImportRoutes } from "./routes/imports.ts";
import { isAllowedSiteHost, isStaticSiteHost } from "./config/site-host.ts";
import {
  auditAdminMutation,
  markAdminReadRequest
} from "./core/audit-log.ts";
import { blockCrossSiteFetch } from "./core/http/request-security.ts";
import {
  businessAvailabilityGateIsOpen,
  requireOperationalRedis
} from "./core/runtime-availability.ts";

type HttpAvailabilityDependencies = {
  businessGateIsOpen(): boolean;
  requireRedis(): Promise<unknown>;
};

const defaultHttpAvailabilityDependencies: HttpAvailabilityDependencies = {
  businessGateIsOpen: businessAvailabilityGateIsOpen,
  requireRedis: requireOperationalRedis
};

export function createHttpApp(): Hono;
export function createHttpApp(
  availability: HttpAvailabilityDependencies
): Hono;
export function createHttpApp(
  availability: HttpAvailabilityDependencies =
    defaultHttpAvailabilityDependencies
) {
  // Route handlers depend on the process-wide runtime snapshot. Keep assembly
  // explicit so importing this module remains pure while incorrect startup
  // order fails before the application can accept requests.
  getRuntimeConfig();

  const app = new Hono();

  app.onError((error, c) => handleApiError(c, error));
  app.use("*", async (c, next) => {
    await next();
    finalizeSecurityHeaders(c);
  });
  app.use("*", async (c, next) => {
    if (!isAllowedSiteHost(c.req.header("host") ?? "")) {
      return apiErrorResponse({ status: 404, message: "Not Found" });
    }
    await next();
  });
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (
      path === "/livez"
      || path === "/readyz"
      || availability.businessGateIsOpen()
    ) {
      await next();
      return;
    }
    return apiErrorResponse(
      {
        status: 503,
        code: "redis_unavailable",
        message: "Redis cold-start validation has not completed"
      },
      { phase: "cold_start" }
    );
  });
  app.use("*", async (c, next) => {
    if (!isStaticSiteHost(c.req.header("host") ?? "")) {
      return next();
    }
    const path = new URL(c.req.url).pathname;
    if (
      path === "/robots.txt"
      || path.startsWith("/media/")
      || path.startsWith("/thumbs/")
      || path.startsWith("/link/original/")
    ) {
      return next();
    }
    return apiErrorResponse({ status: 404, message: "Not Found" });
  });
  app.options(
    "*",
    async (c, next) => {
      await c.req.raw.body?.cancel().catch(() => undefined);
      return next();
    },
    blockCrossSiteFetch,
    async () => new Response(null, {
      status: 204,
      headers: { "Cache-Control": noStoreCacheControl }
    })
  );
  app.get("/robots.txt", serveRobotsTxt);

  const resourceHostGuard = async (c: Context, next: Next) => {
    if (isStaticSiteHost(c.req.header("host") ?? "")) return next();
    return apiErrorResponse({ status: 404, message: "Not Found" });
  };
  app.use("/media/*", resourceHostGuard);
  app.use("/thumbs/*", resourceHostGuard);
  app.use("/link/original/*", resourceHostGuard);

  app.use("/api/*", limitApiRequestBody);
  app.use("/api/*", async (c, next) => {
    await next();
    appendVaryHeader(c, "Accept-Encoding");
  });
  const apiCompress = compress({ threshold: 1024 });
  app.use("/api/*", async (c, next) => {
    if (
      new URL(c.req.url).pathname ===
        `${adminApiBasePath}/imports/events`
    ) {
      return next();
    }
    let temporaryContentLength = false;
    await apiCompress(c, async () => {
      await next();
      temporaryContentLength = await prepareCompressionThreshold(c, 1024);
    });
    if (
      temporaryContentLength
      && !c.res.headers.has("Content-Encoding")
    ) {
      c.res.headers.delete("Content-Length");
    }
  });
  app.use("/api/*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) {
      c.header("Cache-Control", noStoreCacheControl);
    }
  });

  registerHealthRoutes(app);
  registerPublicRoutes(app);
  registerRandomRoutes(app);
  app.use(`${adminApiBasePath}/*`, async (_c, next) => {
    await availability.requireRedis();
    await next();
  });
  registerPublicAuthRoutes(app);
  registerSecurityReportRoutes(app);

  const adminReadPostPaths = new Set([
    `${adminApiBasePath}/imports/status`,
    `${adminApiBasePath}/imports/events`
  ]);
  app.use(`${adminApiBasePath}/*`, async (c, next) => {
    if (
      c.req.method === "POST"
      && adminReadPostPaths.has(new URL(c.req.url).pathname)
    ) {
      markAdminReadRequest(c);
    }
    await next();
  });
  app.use(`${adminApiBasePath}/*`, requireAdminSession);
  app.use(`${adminApiBasePath}/*`, auditAdminMutation);
  app.use(`${adminApiBasePath}/*`, async (c, next) => {
    if (c.req.method !== "GET") return requireAdminCsrf(c, next);
    await next();
  });
  app.use(`${adminApiBasePath}/*`, limitProtectedAdminRequestBody);
  registerProtectedAuthRoutes(app);

  registerAdminImageRoutes(app);
  registerAdminTagRoutes(app);
  registerAdminThemeRoutes(app);
  registerAdminAuthorRoutes(app);
  registerAdminUserRoutes(app);
  registerAdminPreferenceRoutes(app);
  registerAdminCacheRoutes(app);
  registerImportRoutes(app);
  registerAdminLogRoutes(app);
  registerAdvancedConfigRoutes(app);
  registerSettingsRoutes(app);
  registerStorageRoutes(app);
  registerCheckRoutes(app);
  registerSpaRoutes(app);
  app.notFound(() => apiErrorResponse({ status: 404, message: "Not Found" }));

  return app;
}
