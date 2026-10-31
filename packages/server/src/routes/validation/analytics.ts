import { z } from "zod";
import {
  analyticsBridges,
  analyticsBrowserSupports,
  analyticsCatalogTargets,
  analyticsClearScopes,
  analyticsCollectLimits,
  analyticsColorSchemes,
  analyticsErrorCodePattern,
  analyticsFallbackReasons,
  analyticsEarliestDay,
  analyticsHostPattern,
  analyticsMaxRangeDays,
  analyticsPages,
  analyticsShowControls,
  analyticsViewports,
  publicImageOrders,
  showModes,
  type AnalyticsClearRequestDto,
  type AnalyticsCollectRequestDto
} from "@imageshow/shared/browser";
import { uuidInput } from "./primitives.ts";

const limits = analyticsCollectLimits;
const hostInput = z.string().toLowerCase().regex(analyticsHostPattern).nullable();
const durationMs = z.number().int().min(0).max(limits.maxDurationMs);
const timingMs = durationMs.nullable();

const eventBase = {
  page: z.enum(analyticsPages),
  embedded: z.boolean()
};

const eventInput = z.discriminatedUnion("event", [
  z.strictObject({
    ...eventBase,
    event: z.literal("page_view"),
    referrer: hostInput,
    embed_host: hostInput,
    entry: z.boolean(),
    support: z.enum(analyticsBrowserSupports),
    new_visitor: z.boolean(),
    viewport: z.enum(analyticsViewports),
    color_scheme: z.enum(analyticsColorSchemes),
    reduced_motion: z.boolean()
  }),
  z.strictObject({ ...eventBase, event: z.literal("page_leave"), visible_ms: durationMs }),
  z.strictObject({
    ...eventBase,
    event: z.literal("error_shown"),
    status: z.number().int().min(100).max(599).nullable(),
    code: z.string().regex(analyticsErrorCodePattern).nullable()
  }),
  z.strictObject({ ...eventBase, event: z.literal("fallback"), reason: z.enum(analyticsFallbackReasons) }),
  z.strictObject({ ...eventBase, event: z.literal("catalog_click"), target: z.enum(analyticsCatalogTargets) }),
  z.strictObject({ ...eventBase, event: z.literal("sort_change"), order: z.enum(publicImageOrders) }),
  z.strictObject({
    ...eventBase,
    event: z.literal("list_progress"),
    pages: z.number().int().min(1).max(100_000),
    reached_end: z.boolean()
  }),
  z.strictObject({ ...eventBase, event: z.literal("show_start"), mode: z.enum(showModes), switched: z.boolean() }),
  z.strictObject({
    ...eventBase,
    event: z.literal("show_end"),
    mode: z.enum(showModes),
    duration_ms: durationMs
  }),
  z.strictObject({ ...eventBase, event: z.literal("control_use"), control: z.enum(analyticsShowControls) }),
  z.strictObject({ ...eventBase, event: z.literal("bridge_failed"), bridge: z.enum(analyticsBridges) }),
  z.strictObject({ ...eventBase, event: z.literal("image_failures"), count: z.number().int().min(1).max(limits.maxImageFailures) }),
  z.strictObject({ ...eventBase, event: z.literal("perf"), ttfb_ms: timingMs, fcp_ms: timingMs, lcp_ms: timingMs })
]);

export const analyticsCollectInput = z.strictObject({
  visitor: uuidInput,
  session: uuidInput,
  events: z.array(eventInput).min(1).max(limits.maxEvents)
}) satisfies z.ZodType<AnalyticsCollectRequestDto>;

export const analyticsClearInput = z.strictObject({
  scope: z.enum(analyticsClearScopes)
}) satisfies z.ZodType<AnalyticsClearRequestDto>;

const dayMs = 24 * 60 * 60 * 1000;
const dayInput = z.iso.date().refine((day) => day >= analyticsEarliestDay, {
  message: `日期不能早于 ${analyticsEarliestDay}`
});

/** Either the last `days` days ending today in the server's zone, or explicit dates. */
export const analyticsRangeQuery = z.union([
  z.strictObject({ days: z.coerce.number().int().min(1).max(analyticsMaxRangeDays) }),
  z
    .strictObject({ from: dayInput, to: dayInput })
    .refine(({ from, to }) => from <= to, { message: "开始日期不能晚于结束日期", path: ["from"] })
    .refine(
      ({ from, to }) => Date.parse(to) - Date.parse(from) < analyticsMaxRangeDays * dayMs,
      { message: `时间范围最长 ${analyticsMaxRangeDays} 天`, path: ["to"] }
    )
]);
