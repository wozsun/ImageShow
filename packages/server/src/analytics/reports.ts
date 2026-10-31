import {
  analyticsCollectDropReasons,
  analyticsColorSchemes,
  analyticsDirectHost,
  analyticsListDepths,
  analyticsOtherHost,
  analyticsSessionDepths,
  analyticsTimingBuckets,
  analyticsTimings,
  analyticsViewports,
  type AnalyticsBridge,
  type AnalyticsBrowserSupport,
  type AnalyticsCatalogTarget,
  type AnalyticsColorScheme,
  type AnalyticsContentDto,
  type AnalyticsErrorsDto,
  type AnalyticsFallbackReason,
  type AnalyticsListDepth,
  type AnalyticsOverviewDto,
  type AnalyticsPage,
  type AnalyticsPageUsageDto,
  type AnalyticsPerformanceDto,
  type AnalyticsRandomDto,
  type AnalyticsRangeDto,
  type AnalyticsSection,
  type AnalyticsSectionDto,
  type AnalyticsSessionDepth,
  type AnalyticsShowControl,
  type AnalyticsSourcesDto,
  type AnalyticsTotalsDto,
  type AnalyticsViewport,
  type PublicImageOrder,
  type RandomApiStatusClass,
  type ShowMode
} from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { ApiError } from "../core/api-error.ts";
import { pool } from "../core/database/pools.ts";
import {
  collectDroppedMetric,
  computeDailyMetrics,
  rawPrunedMetric,
  rollupMarkerMetric,
  type DailyMetricRow
} from "./daily-metrics.ts";
import { analyticsTimeZone } from "./time-zone.ts";

type DayRange = { from: string; to: string };
type RangeRequest = DayRange | { days: number };

/** The server's local day and the first day raw rows are complete for; read once per report. */
type Calendar = {
  timeZone: string;
  today: string;
  rawFrom: string;
};

type RangeContext = {
  range: AnalyticsRangeDto;
  days: string[];
  liveDays: string[];
  timeZone: string;
};

const dayMs = 24 * 60 * 60 * 1000;
const listLimit = 50;

function shiftDay(day: string, offset: number) {
  return new Date(Date.parse(day) + offset * dayMs).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string) {
  const days: string[] = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) days.push(day);
  return days;
}

async function readCalendar(): Promise<Calendar> {
  const timeZone = analyticsTimeZone();
  const { today, pruned } = (
    await pool.query<{ today: string; pruned: string | null }>(
      `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today,
              (SELECT to_char(max(day), 'YYYY-MM-DD') FROM analytics_daily WHERE metric = $2) AS pruned`,
      [timeZone, rawPrunedMetric]
    )
  ).rows[0]!;
  // Raw rows cover the configured retention, but only from the day after the
  // latest pruning: a shorter retention used before may have removed more.
  const retentionStart = shiftDay(today, 1 - getRuntimeConfig().analytics.visit_retention_days);
  const afterPruned = pruned ? shiftDay(pruned, 1) : retentionStart;
  return {
    timeZone,
    today,
    rawFrom: afterPruned > retentionStart ? afterPruned : retentionStart
  };
}

async function rangeContext(
  { timeZone, today, rawFrom }: Calendar,
  { from, to }: DayRange
): Promise<RangeContext> {
  if (to > today) {
    throw new ApiError(400, "validation_error", "结束日期不能晚于今天");
  }
  const rolled = new Set(
    (
      await pool.query<{ day: string }>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day
           FROM analytics_daily
          WHERE metric = $1 AND day BETWEEN $2::date AND $3::date`,
        [rollupMarkerMetric, from, to]
      )
    ).rows.map((row) => row.day)
  );
  const days = daysBetween(from, to);
  return {
    range: { from, to, today, raw_from: rawFrom },
    days,
    liveDays: days.filter((day) => day >= rawFrom && !rolled.has(day)),
    timeZone
  };
}

/**
 * Stored rollups for rolled-up days plus live rows for the rest. A day rolled
 * up between reading the markers and the rows still counts once, live.
 */
async function rangeRows(context: RangeContext, metrics: readonly string[]) {
  const { from, to } = context.range;
  const stored = (
    await pool.query<{
      day: string;
      metric: string;
      dimensions: Record<string, unknown>;
      count: string;
      visitors: string;
    }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, metric, dimensions,
              count::text AS count, visitors::text AS visitors
         FROM analytics_daily
        WHERE day BETWEEN $1::date AND $2::date
          AND metric = ANY($3::text[])
          AND day <> ALL($4::date[])`,
      [from, to, metrics, context.liveDays]
    )
  ).rows.map((row): DailyMetricRow => ({
    ...row,
    count: Number(row.count),
    visitors: Number(row.visitors)
  }));
  const live = await computeDailyMetrics(pool, context.liveDays, context.timeZone, metrics);
  return [...stored, ...live];
}

type Totals = { count: number; visitors: number };

/** Sums rows of one metric by the chosen dimensions. */
function sumBy<K extends string>(
  rows: readonly DailyMetricRow[],
  metric: string,
  key: (dimensions: Record<string, unknown>) => K | null
) {
  const sums = new Map<K, Totals>();
  for (const row of rows) {
    if (row.metric !== metric) continue;
    const group = key(row.dimensions);
    if (group === null) continue;
    const current = sums.get(group) ?? { count: 0, visitors: 0 };
    current.count += row.count;
    current.visitors += row.visitors;
    sums.set(group, current);
  }
  return sums;
}

function total(rows: readonly DailyMetricRow[], metric: string) {
  return rows.reduce((sum, row) => (row.metric === metric ? sum + row.count : sum), 0);
}

function compareKeys(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

// Ties keep a fixed order, whatever order the rows came in.
function topEntries<K extends string>(sums: Map<K, Totals>, limit = listLimit) {
  return [...sums.entries()]
    .sort((left, right) => right[1].count - left[1].count || compareKeys(left[0], right[0]))
    .slice(0, limit);
}

/** Counts in the given order; empty when every count is zero. */
function inOrder<K extends string>(keys: readonly K[], sums: Map<K, Totals>) {
  const counted = keys.map((key) => [key, sums.get(key)?.count ?? 0] as const);
  return counted.some(([, count]) => count > 0) ? counted : [];
}

function averageOrNull(sum: number, count: number) {
  return count > 0 ? Math.round(sum / count) : null;
}

const pageKey = (dimensions: Record<string, unknown>) =>
  `${String(dimensions.page)}:${dimensions.embedded === true}`;

async function exactRangeCounts(context: RangeContext) {
  const { from, to } = context.range;
  const row = (
    await pool.query<{ visitors: string; sessions: string; embedded_visitors: string }>(
      `SELECT count(DISTINCT visitor_id)::text AS visitors, count(DISTINCT session_id)::text AS sessions,
              (count(DISTINCT visitor_id) FILTER (WHERE embedded))::text AS embedded_visitors
         FROM visit_event
        WHERE event = 'page_view'
          AND occurred_at >= $1::date::timestamp AT TIME ZONE $3
          AND occurred_at < ($2::date + 1)::timestamp AT TIME ZONE $3`,
      [from, to, context.timeZone]
    )
  ).rows[0];
  return {
    visitors: Number(row?.visitors ?? 0),
    sessions: Number(row?.sessions ?? 0),
    embeddedVisitors: Number(row?.embedded_visitors ?? 0)
  };
}

const pageUsageMetrics = ["page", "page_entries", "page_visible", "event"];

/** Views, entries and average visible time per page, direct and embedded apart. */
function pageUsage(rows: readonly DailyMetricRow[]): AnalyticsPageUsageDto[] {
  const views = sumBy(rows, "page", pageKey);
  const entries = sumBy(rows, "page_entries", pageKey);
  const visible = sumBy(rows, "page_visible", pageKey);
  const leaves = sumBy(rows, "event", (dimensions) =>
    dimensions.event === "page_leave" ? pageKey(dimensions) : null
  );
  return topEntries(views).map(([key, sums]) => {
    const [page, embedded] = key.split(":");
    return {
      page: page as AnalyticsPage,
      embedded: embedded === "true",
      page_views: sums.count,
      entries: entries.get(key)?.count ?? 0,
      visible_ms_average: averageOrNull(visible.get(key)?.count ?? 0, leaves.get(key)?.count ?? 0)
    };
  });
}

const overviewMetrics = [
  "site", "site_sessions", "site_new", "session_depth", ...pageUsageMetrics, "page_hour", "random"
];

function embeddedPageViews(rows: readonly DailyMetricRow[]) {
  return total(rows.filter((row) => row.dimensions.embedded === true), "page");
}

// 0 is Monday, matching how weeks are read on the page.
function weekdayOf(day: string) {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

async function rangeTotals(context: RangeContext, rows: readonly DailyMetricRow[]): Promise<AnalyticsTotalsDto> {
  const dailyVisitors = new Map(context.days.map((day) => [day, 0]));
  for (const row of rows) {
    if (row.metric === "site") dailyVisitors.set(row.day, row.visitors);
  }
  const visitorValues = [...dailyVisitors.values()];
  // Distinct visitors across days need raw events; older ranges show the
  // daily average and peak instead.
  const exact = context.range.from >= context.range.raw_from
    ? await exactRangeCounts(context)
    : null;
  const leaves = total(rows.filter((row) => row.dimensions.event === "page_leave"), "event");
  return {
    page_views: total(rows, "site"),
    visitors: exact?.visitors ?? null,
    visitors_daily_average: visitorValues.length
      ? Math.round(visitorValues.reduce((sum, value) => sum + value, 0) / visitorValues.length)
      : 0,
    visitors_daily_peak: Math.max(0, ...visitorValues),
    sessions: exact?.sessions ?? total(rows, "site_sessions"),
    new_visitors: total(rows, "site_new"),
    visible_ms: total(rows, "page_visible"),
    visible_ms_average: averageOrNull(total(rows, "page_visible"), leaves),
    embedded_page_views: embeddedPageViews(rows),
    random_requests: total(rows, "random")
  };
}

// Page views carry no heartbeat: a visitor who stays on one page stops counting here.
async function recentVisitors() {
  const row = (
    await pool.query<{ visitors: string }>(
      `SELECT count(DISTINCT visitor_id)::text AS visitors
         FROM visit_event
        WHERE event = 'page_view' AND occurred_at >= now() - interval '5 minutes'`
    )
  ).rows[0];
  return Number(row?.visitors ?? 0);
}

async function overview(calendar: Calendar, range: DayRange): Promise<AnalyticsOverviewDto> {
  const context = await rangeContext(calendar, range);
  const span = context.days.length;
  const previousContext = await rangeContext(calendar, {
    from: shiftDay(range.from, -span),
    to: shiftDay(range.from, -1)
  });
  const [rows, previousRows] = await Promise.all([
    rangeRows(context, overviewMetrics),
    rangeRows(previousContext, overviewMetrics)
  ]);
  const [totals, previous, recent] = await Promise.all([
    rangeTotals(context, rows),
    rangeTotals(previousContext, previousRows),
    recentVisitors()
  ]);
  const daily = new Map(context.days.map((day) => [day, { day, page_views: 0, visitors: 0 }]));
  for (const row of rows) {
    if (row.metric !== "site") continue;
    const entry = daily.get(row.day);
    if (entry) {
      entry.page_views += row.count;
      entry.visitors += row.visitors;
    }
  }
  const hours = Array.from({ length: 7 * 24 }, (_, index) => ({
    weekday: Math.floor(index / 24),
    hour: index % 24,
    page_views: 0
  }));
  for (const row of rows) {
    if (row.metric !== "page_hour") continue;
    hours[weekdayOf(row.day) * 24 + Number(row.dimensions.hour)]!.page_views += row.count;
  }
  return {
    range: context.range,
    totals,
    previous,
    daily: [...daily.values()],
    hours,
    pages: pageUsage(rows),
    session_depth: inOrder(
      analyticsSessionDepths,
      sumBy(rows, "session_depth", (dimensions) => String(dimensions.pages) as AnalyticsSessionDepth)
    ).map(([pages, sessions]) => ({ pages, sessions })),
    recent_visitors: recent
  };
}

async function content(calendar: Calendar, range: DayRange): Promise<AnalyticsContentDto> {
  const context = await rangeContext(calendar, range);
  const rows = await rangeRows(context, [
    "sort", "show_starts", "show_switched", "show_duration", "control",
    "list_progress", "list_pages", "list_depth", "catalog"
  ]);
  const byMode = (metric: string) => sumBy(rows, metric, (dimensions) => String(dimensions.mode) as ShowMode);
  const starts = byMode("show_starts");
  const switched = byMode("show_switched");
  const durations = byMode("show_duration");
  const depths = sumBy(rows, "list_depth", (dimensions) => String(dimensions.pages) as AnalyticsListDepth);
  return {
    range: context.range,
    sorts: topEntries(sumBy(rows, "sort", (dimensions) => String(dimensions.order) as PublicImageOrder))
      .map(([order, sums]) => ({ order, count: sums.count })),
    show: topEntries(starts).map(([mode, sums]) => ({
      mode,
      starts: sums.count,
      switched: switched.get(mode)?.count ?? 0,
      duration_ms: durations.get(mode)?.count ?? 0
    })),
    controls: topEntries(sumBy(rows, "control", (dimensions) => String(dimensions.control) as AnalyticsShowControl))
      .map(([control, sums]) => ({ control, count: sums.count })),
    gallery_depth: {
      views: total(rows, "list_progress"),
      pages: total(rows, "list_pages"),
      reached_end: sumBy(rows, "list_progress", (dimensions) =>
        dimensions.reached_end === true ? "end" : null).get("end")?.count ?? 0,
      distribution: analyticsListDepths.map((pages) => ({ pages, count: depths.get(pages)?.count ?? 0 }))
    },
    catalog: topEntries(sumBy(rows, "catalog", (dimensions) => String(dimensions.target) as AnalyticsCatalogTarget))
      .map(([target, sums]) => ({ target, count: sums.count }))
  };
}

async function sources(calendar: Calendar, range: DayRange): Promise<AnalyticsSourcesDto> {
  const context = await rangeContext(calendar, range);
  const rows = await rangeRows(context, [
    "site", ...pageUsageMetrics, "referrer", "embed_host", "device", "os", "support", "fallback",
    "legacy_browser", "viewport", "color_scheme", "reduced_motion"
  ]);
  const hostRows = (metric: string) =>
    topEntries(sumBy(rows, metric, (dimensions) => String(dimensions.host ?? analyticsDirectHost)))
      .map(([host, sums]) => ({ host, page_views: sums.count }));
  const breakdown = <K extends string>(metric: string, key: (dimensions: Record<string, unknown>) => K) =>
    topEntries(sumBy(rows, metric, key));
  const embedHosts = hostRows("embed_host");
  const daily = new Map(context.days.map((day) => [day, { day, page_views: 0, embedded_page_views: 0 }]));
  for (const row of rows) {
    const entry = daily.get(row.day);
    if (!entry) continue;
    if (row.metric === "site") entry.page_views += row.count;
    if (row.metric === "page" && row.dimensions.embedded === true) entry.embedded_page_views += row.count;
  }
  const exact = context.range.from >= context.range.raw_from ? await exactRangeCounts(context) : null;
  return {
    range: context.range,
    embed: {
      host: embedHosts.find((row) => row.host !== analyticsDirectHost && row.host !== analyticsOtherHost)?.host ?? null,
      page_views: embeddedPageViews(rows),
      site_page_views: total(rows, "site"),
      visitors: exact?.embeddedVisitors ?? null,
      daily: [...daily.values()],
      pages: pageUsage(rows)
    },
    referrers: hostRows("referrer"),
    embed_hosts: embedHosts,
    devices: breakdown("device", (dimensions) => String(dimensions.device))
      .map(([device, sums]) => ({ device, page_views: sums.count })),
    browsers: breakdown("device", (dimensions) => String(dimensions.browser))
      .map(([browser, sums]) => ({ browser, page_views: sums.count })),
    systems: breakdown("os", (dimensions) => String(dimensions.os))
      .map(([os, sums]) => ({ os, page_views: sums.count })),
    supports: breakdown("support", (dimensions) => String(dimensions.support) as AnalyticsBrowserSupport)
      .map(([support, sums]) => ({ support, page_views: sums.count })),
    fallbacks: breakdown("fallback", (dimensions) => String(dimensions.reason) as AnalyticsFallbackReason)
      .map(([reason, sums]) => ({ reason, count: sums.count })),
    legacy_browsers: breakdown("legacy_browser", (dimensions) =>
      JSON.stringify([dimensions.browser, dimensions.major ?? null])
    ).map(([key, sums]) => {
      const [browser, major] = JSON.parse(key) as [string, number | null];
      return { browser, major, page_views: sums.count };
    }),
    viewports: inOrder(analyticsViewports, sumBy(rows, "viewport", (dimensions) =>
      String(dimensions.viewport) as AnalyticsViewport
    )).map(([viewport, page_views]) => ({ viewport, page_views })),
    color_schemes: inOrder(analyticsColorSchemes, sumBy(rows, "color_scheme", (dimensions) =>
      String(dimensions.scheme) as AnalyticsColorScheme
    )).map(([scheme, page_views]) => ({ scheme, page_views })),
    reduced_motion: inOrder(["false", "true"] as const, sumBy(rows, "reduced_motion", (dimensions) =>
      dimensions.reduced === true ? "true" as const : "false" as const
    )).map(([reduced, page_views]) => ({ reduced: reduced === "true", page_views }))
  };
}

/**
 * Every hour bucket of the local day, empty ones included. Buckets start on
 * whole UTC hours and belong to the local day they start in, as in rollups,
 * so zones with half-hour offsets get labels such as 00:30.
 */
async function hourlyRandomSeries(context: RangeContext) {
  return (
    await pool.query<{ at: string; requests: string; images: string }>(
      `SELECT to_char(hours.hour AT TIME ZONE $2, 'YYYY-MM-DD"T"HH24:MI') AS at,
              coalesce(sum(counted.requests), 0)::text AS requests,
              coalesce(sum(counted.images), 0)::text AS images
         FROM generate_series(
                date_trunc('hour', $1::date::timestamp AT TIME ZONE $2, 'UTC'),
                ($1::date + 1)::timestamp AT TIME ZONE $2,
                interval '1 hour'
              ) AS hours(hour)
         LEFT JOIN random_api_hourly counted ON counted.hour = hours.hour
        WHERE (hours.hour AT TIME ZONE $2)::date = $1::date
        GROUP BY hours.hour
        ORDER BY hours.hour`,
      [context.range.from, context.timeZone]
    )
  ).rows.map((row) => ({ at: row.at, requests: Number(row.requests), images: Number(row.images) }));
}

async function randomApi(calendar: Calendar, range: DayRange): Promise<AnalyticsRandomDto> {
  const context = await rangeContext(calendar, range);
  const rows = await rangeRows(context, [
    "random", "random_images", "random_duration", "random_duration_max", "random_option"
  ]);
  const hourly = context.days.length === 1 && range.from >= context.range.raw_from;
  const daily = new Map(context.days.map((day) => [day, { at: day, requests: 0, images: 0 }]));
  for (const row of rows) {
    const entry = daily.get(row.day);
    if (!entry) continue;
    if (row.metric === "random") entry.requests += row.count;
    if (row.metric === "random_images") entry.images += row.count;
  }
  const modeKey = (dimensions: Record<string, unknown>) =>
    JSON.stringify([dimensions.mode, dimensions.method, dimensions.status]);
  const hostKey = (dimensions: Record<string, unknown>) =>
    JSON.stringify([dimensions.host, dimensions.trusted === true]);
  const modeImages = sumBy(rows, "random_images", modeKey);
  const modeDurations = sumBy(rows, "random_duration", modeKey);
  const hostImages = sumBy(rows, "random_images", hostKey);
  const requests = sumBy(rows, "random", (dimensions) =>
    JSON.stringify([dimensions.status, dimensions.trusted === true])
  );
  let trustedRequests = 0;
  let rateLimited = 0;
  for (const [key, sums] of requests) {
    const [status, trusted] = JSON.parse(key) as [RandomApiStatusClass, boolean];
    if (trusted) trustedRequests += sums.count;
    if (status === "rate_limited") rateLimited += sums.count;
  }
  return {
    range: context.range,
    granularity: hourly ? "hour" : "day",
    series: hourly ? await hourlyRandomSeries(context) : [...daily.values()],
    modes: topEntries(sumBy(rows, "random", modeKey)).map(([key, sums]) => {
      const [mode, method, status] = JSON.parse(key) as [string, "GET" | "HEAD", RandomApiStatusClass];
      return {
        mode,
        method,
        status,
        requests: sums.count,
        images: modeImages.get(key)?.count ?? 0,
        duration_ms: modeDurations.get(key)?.count ?? 0
      };
    }),
    hosts: topEntries(sumBy(rows, "random", hostKey)).map(([key, sums]) => {
      const [host, trusted] = JSON.parse(key) as [string, boolean];
      return { host, trusted, requests: sums.count, images: hostImages.get(key)?.count ?? 0 };
    }),
    options: topEntries(sumBy(rows, "random_option", (dimensions) =>
      JSON.stringify([dimensions.option, dimensions.value])
    ), 100).map(([key, sums]) => {
      const [option, value] = JSON.parse(key) as [string, string];
      return { option, value, requests: sums.count };
    }),
    totals: {
      requests: total(rows, "random"),
      images: total(rows, "random_images"),
      trusted_requests: trustedRequests,
      rate_limited: rateLimited,
      duration_ms: total(rows, "random_duration"),
      // Each row is a day's maximum; the range's is the largest of them.
      duration_ms_max: rows.reduce(
        (largest, row) => (row.metric === "random_duration_max" ? Math.max(largest, row.count) : largest),
        0
      )
    }
  };
}

async function pageTimings(calendar: Calendar, range: DayRange): Promise<AnalyticsPerformanceDto> {
  const context = await rangeContext(calendar, range);
  const sums = sumBy(await rangeRows(context, ["perf"]), "perf", (dimensions) =>
    JSON.stringify([dimensions.timing, dimensions.bucket])
  );
  return {
    range: context.range,
    timings: analyticsTimings.flatMap((timing) => analyticsTimingBuckets.map((bucket) => ({
      timing,
      bucket,
      count: sums.get(JSON.stringify([timing, bucket]))?.count ?? 0
    })))
  };
}

// Drops are added up as they happen, so every day of the range reads stored rows.
async function collectDrops(context: RangeContext) {
  const counts = new Map(
    (
      await pool.query<{ reason: string; count: string }>(
        `SELECT dimensions->>'reason' AS reason, sum(count)::text AS count
           FROM analytics_daily
          WHERE metric = $1 AND day BETWEEN $2::date AND $3::date
          GROUP BY dimensions->>'reason'`,
        [collectDroppedMetric, context.range.from, context.range.to]
      )
    ).rows.map((row) => [row.reason, Number(row.count)])
  );
  return analyticsCollectDropReasons
    .map((reason) => ({ reason, count: counts.get(reason) ?? 0 }))
    .filter((row) => row.count > 0);
}

async function errors(calendar: Calendar, range: DayRange): Promise<AnalyticsErrorsDto> {
  const context = await rangeContext(calendar, range);
  const rows = await rangeRows(context, ["error", "bridge", "image_failures"]);
  return {
    range: context.range,
    errors: topEntries(sumBy(rows, "error", (dimensions) =>
      JSON.stringify([dimensions.page, dimensions.status ?? null, dimensions.code ?? null])
    ), 100).map(([key, sums]) => {
      const [page, status, code] = JSON.parse(key) as [AnalyticsPage, number | null, string | null];
      return { page, status, code, count: sums.count };
    }),
    bridges: topEntries(sumBy(rows, "bridge", (dimensions) => String(dimensions.bridge) as AnalyticsBridge))
      .map(([bridge, sums]) => ({ bridge, count: sums.count })),
    image_failures: topEntries(sumBy(rows, "image_failures", (dimensions) => String(dimensions.page) as AnalyticsPage))
      .map(([page, sums]) => ({ page, count: sums.count })),
    collect_dropped: await collectDrops(context)
  };
}

const sectionReports: {
  [Section in AnalyticsSection]: (calendar: Calendar, range: DayRange) => Promise<AnalyticsSectionDto[Section]>
} = {
  overview,
  content,
  sources,
  random: randomApi,
  performance: pageTimings,
  errors
};

export async function analyticsReport<Section extends AnalyticsSection>(section: Section, request: RangeRequest) {
  const calendar = await readCalendar();
  const range = "days" in request
    ? { from: shiftDay(calendar.today, 1 - request.days), to: calendar.today }
    : request;
  return sectionReports[section](calendar, range);
}
