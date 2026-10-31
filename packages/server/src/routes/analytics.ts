import { hash } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import {
  adminApiBasePath,
  adminPermissions,
  analyticsCollectPath,
  analyticsSections,
  analyticsTodayVisitorsPath,
  type AnalyticsTodayVisitorsDto
} from "@imageshow/shared/browser";
import { bufferCollectedEvents } from "../analytics/collect.ts";
import { countCollectDrops } from "../analytics/collect-drops.ts";
import { analyticsReport } from "../analytics/reports.ts";
import { clearAnalyticsData, noteBufferedVisitEvents } from "../analytics/runtime.ts";
import { forgetTodayVisitors, todayVisitors } from "../analytics/today-visitors.ts";
import { visitorAgent } from "../analytics/user-agent.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { ApiError } from "../core/api-error.ts";
import { noStoreCacheControl, publicCounterCacheControl } from "../core/http/headers.ts";
import { readJsonBody } from "../core/http/json-body.ts";
import {
  assertSameOrigin,
  blockCrossSiteFetch,
  requestClientIp
} from "../core/http/request-security.ts";
import { apiErrorResponse, apiSuccess, cacheableApiSuccess } from "../core/http/responses.ts";
import { reserveRedisWindows } from "../core/redis/window-limit.ts";
import { requireAdminPermission } from "../users/admin-authorization.ts";
import {
  analyticsClearInput,
  analyticsCollectInput,
  analyticsRangeQuery
} from "./validation/analytics.ts";
import { parse } from "./validation/parse.ts";

// A page sends a few batches a minute; the cap only stops floods.
const collectWindow = { capacity: 120, windowSeconds: 60 };

/**
 * Site-wide caps on accepted events. Addresses are cheap to rotate (IPv6), so
 * only a total bounds how fast raw rows can grow; what exceeds it is dropped.
 */
async function reserveSiteEvents(events: number) {
  const { collect_events_per_minute, collect_events_per_day } = getRuntimeConfig().analytics;
  const reservations = await reserveRedisWindows([
    { key: "imageshow:analytics_events:minute", capacity: collect_events_per_minute, windowSeconds: 60, cost: events },
    { key: "imageshow:analytics_events:day", capacity: collect_events_per_day, windowSeconds: 86_400, cost: events }
  ]);
  return reservations.find((reservation) => !reservation.allowed) ?? null;
}

function accepted() {
  return new Response(null, { status: 204, headers: { "Cache-Control": noStoreCacheControl } });
}

export function registerAnalyticsRoutes(app: Hono) {
  app.post(analyticsCollectPath, blockCrossSiteFetch, async (c) => {
    assertSameOrigin(c);
    if (!getRuntimeConfig().analytics.enabled) {
      throw new ApiError(403, "analytics_disabled", "Analytics is disabled");
    }
    // Crawlers and automated clients are not visitors; their reports are
    // accepted and dropped.
    const agent = visitorAgent(c.req.header("user-agent") ?? "");
    if (!agent) {
      await c.req.raw.body?.cancel().catch(() => undefined);
      return accepted();
    }
    const [reservation] = await reserveRedisWindows([
      {
        key: `imageshow:analytics_rate:${hash("sha256", requestClientIp(c), "base64url")}`,
        ...collectWindow
      }
    ]);
    if (!reservation!.allowed) {
      countCollectDrops("ip_rate_limited", 1);
      c.header("Retry-After", String(reservation!.retryAfterSeconds));
      throw new ApiError(429, "analytics_rate_limited", "Too many analytics reports");
    }
    const input = parse(analyticsCollectInput, await readJsonBody(c));
    const rejected = await reserveSiteEvents(input.events.length);
    if (rejected) {
      countCollectDrops("site_capped", input.events.length);
      c.header("Retry-After", String(rejected.retryAfterSeconds));
      throw new ApiError(429, "analytics_rate_limited", "Too many analytics reports");
    }
    const siteHostname = (c.req.header("host") ?? "").replace(/:\d+$/u, "").toLowerCase();
    if (bufferCollectedEvents(input, agent, siteHostname)) noteBufferedVisitEvents();
    return accepted();
  });

  app.get(analyticsTodayVisitorsPath, blockCrossSiteFetch, async (c) => {
    const { enabled, home_visitors } = getRuntimeConfig().analytics;
    if (!enabled || !home_visitors) {
      return apiErrorResponse({ status: 404, message: "Not Found" });
    }
    return cacheableApiSuccess(
      c,
      { visitors: await todayVisitors() } satisfies AnalyticsTodayVisitorsDto,
      publicCounterCacheControl
    );
  });
}

export function registerAdminAnalyticsRoutes(app: Hono) {
  const base = `${adminApiBasePath}/analytics`;
  app.post(
    `${base}/clear`,
    requireAdminPermission(adminPermissions.analyticsManage),
    async (c) => {
      const { scope } = parse(analyticsClearInput, await readJsonBody(c));
      await clearAnalyticsData(scope);
      forgetTodayVisitors();
      return c.json(apiSuccess());
    }
  );

  app.get(
    `${base}/:section`,
    requireAdminPermission(adminPermissions.analyticsView),
    async (c) => {
      const section = parse(z.enum(analyticsSections), c.req.param("section"));
      const range = parse(analyticsRangeQuery, c.req.query());
      return c.json(apiSuccess(await analyticsReport(section, range)));
    }
  );
}
