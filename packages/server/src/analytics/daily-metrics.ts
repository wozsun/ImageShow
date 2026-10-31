import type { DatabaseReader } from "../core/database/pools.ts";

export type DailyMetricRow = {
  day: string;
  metric: string;
  dimensions: Record<string, unknown>;
  count: number;
  visitors: number;
};

/** Marks a day whose rollup replaced live computation from raw rows. */
export const rollupMarkerMetric = "rollup";
/**
 * One row whose day is the latest day pruning may have reached: raw rows are
 * complete only after it, even when a longer retention is configured later.
 */
export const rawPrunedMetric = "raw_pruned";
/**
 * Reports the collector dropped, added up as they happen rather than rolled
 * up from raw rows; a rollup of the day keeps them, a clear of visits removes them.
 */
export const collectDroppedMetric = "collect_dropped";
/** Metrics of the random API scope; every other metric except the markers belongs to visits. */
export const randomApiMetrics = ["random", "random_images", "random_duration", "random_duration_max", "random_option"];

// Client-controlled values (hosts, error codes, legacy browser versions) keep
// at most this many rows per day; the rest merge into the other-host row or drop.
const hostsPerDay = 100;
const errorsPerDay = 100;
const legacyBrowsersPerDay = 100;

const pageKey = "jsonb_build_object('page', page, 'embedded', embedded)";

// Each metric selects (day, metric, dimensions, count, visitors) from the
// scoped CTEs below. Rollups store exactly these rows; reports compute the
// same rows live for days that have no rollup yet.
const metricQueries = [
  `SELECT day, 'site', '{}'::jsonb, count(*), count(DISTINCT visitor_id)
     FROM views GROUP BY day`,
  `SELECT day, 'site_sessions', '{}'::jsonb, count(DISTINCT session_id), 0
     FROM views GROUP BY day`,
  // A visitor ID is created once, so the sum over days counts each new visitor once.
  `SELECT day, 'site_new', '{}'::jsonb, count(DISTINCT visitor_id), count(DISTINCT visitor_id)
     FROM views WHERE (detail->>'new_visitor')::boolean GROUP BY day`,
  // Buckets match analyticsSessionDepths in shared; a session crossing
  // midnight counts on each day with its views of that day.
  `SELECT day, 'session_depth', jsonb_build_object('pages', bucket), count(*), 0
     FROM (
       SELECT day, CASE
                WHEN count(*) <= 2 THEN count(*)::text
                WHEN count(*) <= 4 THEN '3-4'
                ELSE '5+'
              END AS bucket
         FROM views GROUP BY day, session_id
     ) sessions
    GROUP BY day, bucket`,
  `SELECT day, 'page', ${pageKey}, count(*), count(DISTINCT visitor_id)
     FROM views GROUP BY day, page, embedded`,
  `SELECT day, 'page_entries', ${pageKey}, count(*), count(DISTINCT visitor_id)
     FROM views WHERE (detail->>'entry')::boolean GROUP BY day, page, embedded`,
  `SELECT day, 'page_visible', ${pageKey}, sum((detail->>'visible_ms')::bigint), 0
     FROM scoped WHERE event = 'page_leave' GROUP BY day, page, embedded`,
  // Local hour of day, for when the site is used.
  `SELECT day, 'page_hour', jsonb_build_object('hour', hour), count(*), 0
     FROM (SELECT day, extract(hour FROM occurred_at AT TIME ZONE $2)::integer AS hour FROM views) hours
    GROUP BY day, hour`,
  `SELECT day, 'event', jsonb_build_object('event', event, 'page', page, 'embedded', embedded),
          count(*), count(DISTINCT visitor_id)
     FROM scoped GROUP BY day, event, page, embedded`,
  `SELECT day, 'sort', jsonb_build_object('order', detail->>'order'), count(*), count(DISTINCT visitor_id)
     FROM scoped WHERE event = 'sort_change' GROUP BY day, detail->>'order'`,
  `SELECT day, 'catalog', jsonb_build_object('target', detail->>'target'), count(*), count(DISTINCT visitor_id)
     FROM scoped WHERE event = 'catalog_click' GROUP BY day, detail->>'target'`,
  `SELECT day, 'list_progress', jsonb_build_object('reached_end', (detail->>'reached_end')::boolean),
          count(*), count(DISTINCT visitor_id)
     FROM scoped WHERE event = 'list_progress' GROUP BY day, (detail->>'reached_end')::boolean`,
  `SELECT day, 'list_pages', '{}'::jsonb, sum((detail->>'pages')::bigint), 0
     FROM scoped WHERE event = 'list_progress' GROUP BY day`,
  // Buckets match analyticsListDepths in shared; reports drop any other label.
  `SELECT day, 'list_depth', jsonb_build_object('pages', bucket), count(*), 0
     FROM (
       SELECT day, CASE
                WHEN pages <= 2 THEN pages::text
                WHEN pages <= 4 THEN '3-4'
                WHEN pages <= 9 THEN '5-9'
                ELSE '10+'
              END AS bucket
         FROM (SELECT day, (detail->>'pages')::integer AS pages FROM scoped WHERE event = 'list_progress') reports
     ) buckets
    GROUP BY day, bucket`,
  `SELECT day, 'control', jsonb_build_object('control', detail->>'control'), count(*), count(DISTINCT visitor_id)
     FROM scoped WHERE event = 'control_use' GROUP BY day, detail->>'control'`,
  `SELECT day, 'show_starts', jsonb_build_object('mode', detail->>'mode'), count(*), count(DISTINCT visitor_id)
     FROM scoped WHERE event = 'show_start' GROUP BY day, detail->>'mode'`,
  `SELECT day, 'show_switched', jsonb_build_object('mode', detail->>'mode'), count(*), count(DISTINCT visitor_id)
     FROM scoped WHERE event = 'show_start' AND (detail->>'switched')::boolean GROUP BY day, detail->>'mode'`,
  `SELECT day, 'show_duration', jsonb_build_object('mode', detail->>'mode'),
          sum((detail->>'duration_ms')::bigint), 0
     FROM scoped WHERE event = 'show_end' GROUP BY day, detail->>'mode'`,
  // Embedded views belong to their host page, not to a referrer.
  `SELECT day, 'referrer', jsonb_build_object('host', bucket), count(*), count(DISTINCT visitor_id)
     FROM (
       SELECT views.day, views.visitor_id,
              CASE WHEN ranked.host = '' OR ranked.rank <= ${hostsPerDay} THEN ranked.host ELSE '*' END AS bucket
         FROM views
         JOIN (
           SELECT day, coalesce(referrer_host, '') AS host,
                  row_number() OVER (PARTITION BY day ORDER BY count(*) DESC, coalesce(referrer_host, '')) AS rank
             FROM views WHERE NOT embedded GROUP BY day, coalesce(referrer_host, '')
         ) ranked ON ranked.day = views.day AND ranked.host = coalesce(views.referrer_host, '')
        WHERE NOT views.embedded
     ) bucketed
    GROUP BY day, bucket`,
  `SELECT day, 'embed_host', jsonb_build_object('host', bucket), count(*), count(DISTINCT visitor_id)
     FROM (
       SELECT views.day, views.visitor_id,
              CASE WHEN ranked.host = '' OR ranked.rank <= ${hostsPerDay} THEN ranked.host ELSE '*' END AS bucket
         FROM views
         JOIN (
           SELECT day, coalesce(embed_host, '') AS host,
                  row_number() OVER (PARTITION BY day ORDER BY count(*) DESC, coalesce(embed_host, '')) AS rank
             FROM views WHERE embedded GROUP BY day, coalesce(embed_host, '')
         ) ranked ON ranked.day = views.day AND ranked.host = coalesce(views.embed_host, '')
        WHERE views.embedded
     ) bucketed
    GROUP BY day, bucket`,
  `SELECT day, 'device', jsonb_build_object('device', device, 'browser', browser), count(*), count(DISTINCT visitor_id)
     FROM views GROUP BY day, device, browser`,
  `SELECT day, 'os', jsonb_build_object('os', os), count(*), count(DISTINCT visitor_id)
     FROM views GROUP BY day, os`,
  `SELECT day, 'support', jsonb_build_object('support', detail->>'support'), count(*), count(DISTINCT visitor_id)
     FROM views GROUP BY day, detail->>'support'`,
  // Browsers that only get the gallery, by major version: when that path can go.
  `SELECT day, 'legacy_browser', jsonb_build_object('browser', browser, 'major', major), views, visitors
     FROM (
       SELECT day, browser, browser_major AS major, count(*) AS views, count(DISTINCT visitor_id) AS visitors,
              row_number() OVER (PARTITION BY day ORDER BY count(*) DESC, browser, browser_major) AS rank
         FROM views WHERE detail->>'support' = 'gallery'
        GROUP BY day, browser, browser_major
     ) ranked
    WHERE rank <= ${legacyBrowsersPerDay}`,
  `SELECT day, 'viewport', jsonb_build_object('viewport', detail->>'viewport'), count(*), count(DISTINCT visitor_id)
     FROM views WHERE detail ? 'viewport' GROUP BY day, detail->>'viewport'`,
  `SELECT day, 'color_scheme', jsonb_build_object('scheme', detail->>'color_scheme'), count(*), count(DISTINCT visitor_id)
     FROM views WHERE detail ? 'color_scheme' GROUP BY day, detail->>'color_scheme'`,
  `SELECT day, 'reduced_motion', jsonb_build_object('reduced', (detail->>'reduced_motion')::boolean),
          count(*), count(DISTINCT visitor_id)
     FROM views WHERE detail ? 'reduced_motion' GROUP BY day, (detail->>'reduced_motion')::boolean`,
  `SELECT day, 'fallback', jsonb_build_object('reason', detail->>'reason', 'page', page), count(*), count(DISTINCT visitor_id)
     FROM scoped WHERE event = 'fallback' GROUP BY day, detail->>'reason', page`,
  `SELECT day, 'error', jsonb_build_object('page', page, 'status', status, 'code', code), errors, visitors
     FROM (
       SELECT day, page, (detail->>'status')::integer AS status, detail->>'code' AS code,
              count(*) AS errors, count(DISTINCT visitor_id) AS visitors,
              row_number() OVER (
                PARTITION BY day ORDER BY count(*) DESC, page, detail->>'code', (detail->>'status')::integer
              ) AS rank
         FROM scoped WHERE event = 'error_shown'
        GROUP BY day, page, (detail->>'status')::integer, detail->>'code'
     ) ranked
    WHERE rank <= ${errorsPerDay}`,
  `SELECT day, 'bridge', jsonb_build_object('bridge', detail->>'bridge'), count(*), count(DISTINCT visitor_id)
     FROM scoped WHERE event = 'bridge_failed' GROUP BY day, detail->>'bridge'`,
  `SELECT day, 'image_failures', jsonb_build_object('page', page), sum((detail->>'count')::bigint),
          count(DISTINCT visitor_id)
     FROM scoped WHERE event = 'image_failures' GROUP BY day, page`,
  // Buckets match analyticsTimingBuckets in shared.
  `SELECT day, 'perf', jsonb_build_object('timing', timing, 'bucket', bucket), count(*), 0
     FROM (
       SELECT day, timing, CASE
                WHEN ms < 200 THEN '0-200'
                WHEN ms < 500 THEN '200-500'
                WHEN ms < 1000 THEN '500-1000'
                WHEN ms < 2500 THEN '1000-2500'
                WHEN ms < 4000 THEN '2500-4000'
                ELSE '4000+'
              END AS bucket
         FROM scoped
        CROSS JOIN LATERAL (VALUES
          ('ttfb', (detail->>'ttfb_ms')::integer),
          ('fcp', (detail->>'fcp_ms')::integer),
          ('lcp', (detail->>'lcp_ms')::integer)
        ) AS timings(timing, ms)
        WHERE event = 'perf' AND ms IS NOT NULL
     ) bucketed
    GROUP BY day, timing, bucket`,
  `SELECT day, 'random', jsonb_build_object(
            'mode', mode, 'method', method, 'status', status_class, 'trusted', trusted, 'host', bucket
          ), sum(requests), 0
     FROM random_bucketed GROUP BY day, mode, method, status_class, trusted, bucket`,
  `SELECT day, 'random_images', jsonb_build_object(
            'mode', mode, 'method', method, 'status', status_class, 'trusted', trusted, 'host', bucket
          ), sum(images), 0
     FROM random_bucketed GROUP BY day, mode, method, status_class, trusted, bucket`,
  `SELECT day, 'random_duration', jsonb_build_object('mode', mode, 'method', method, 'status', status_class),
          sum(duration_ms_sum), 0
     FROM hourly GROUP BY day, mode, method, status_class`,
  `SELECT day, 'random_duration_max', jsonb_build_object('mode', mode, 'method', method, 'status', status_class),
          max(duration_ms_max), 0
     FROM hourly GROUP BY day, mode, method, status_class`,
  `SELECT day, 'random_option', jsonb_build_object('option', option, 'value', value), sum(requests), 0
     FROM option_hourly GROUP BY day, option, value`
];

/**
 * Daily metric rows for the given local days ($1 date[]) under the time zone
 * $2, computed from the raw visit events and hourly random API counts.
 */
const dailyMetricsSql = `
  WITH days AS (
    SELECT DISTINCT unnest($1::date[]) AS day
  ),
  bounds AS (
    SELECT min(day)::timestamp AT TIME ZONE $2 AS start_at,
           (max(day) + 1)::timestamp AT TIME ZONE $2 AS end_at
      FROM days
  ),
  scoped AS (
    SELECT (raw.occurred_at AT TIME ZONE $2)::date AS day, raw.*
      FROM visit_event raw, bounds
     WHERE raw.occurred_at >= bounds.start_at
       AND raw.occurred_at < bounds.end_at
       AND (raw.occurred_at AT TIME ZONE $2)::date IN (SELECT day FROM days)
  ),
  views AS (
    SELECT * FROM scoped WHERE event = 'page_view'
  ),
  hourly AS (
    SELECT (counted.hour AT TIME ZONE $2)::date AS day, counted.*
      FROM random_api_hourly counted, bounds
     WHERE counted.hour >= bounds.start_at
       AND counted.hour < bounds.end_at
       AND (counted.hour AT TIME ZONE $2)::date IN (SELECT day FROM days)
  ),
  option_hourly AS (
    SELECT (counted.hour AT TIME ZONE $2)::date AS day, counted.*
      FROM random_api_option_hourly counted, bounds
     WHERE counted.hour >= bounds.start_at
       AND counted.hour < bounds.end_at
       AND (counted.hour AT TIME ZONE $2)::date IN (SELECT day FROM days)
  ),
  random_bucketed AS (
    SELECT hourly.*,
           CASE
             WHEN hourly.referrer_host IN ('', '*') OR ranked.rank <= ${hostsPerDay} THEN hourly.referrer_host
             ELSE '*'
           END AS bucket
      FROM hourly
      LEFT JOIN (
        SELECT day, referrer_host,
               row_number() OVER (PARTITION BY day ORDER BY sum(requests) DESC, referrer_host) AS rank
          FROM hourly
         WHERE referrer_host NOT IN ('', '*')
         GROUP BY day, referrer_host
      ) ranked ON ranked.day = hourly.day AND ranked.referrer_host = hourly.referrer_host
  ),
  metrics(day, metric, dimensions, count, visitors) AS (
    ${metricQueries.join("\n    UNION ALL\n    ")}
  )
  SELECT day, metric, dimensions, count, visitors FROM metrics`;

/** Rows of the given metrics; PostgreSQL skips the metric queries not asked for. */
export async function computeDailyMetrics(
  database: DatabaseReader,
  days: readonly string[],
  timeZone: string,
  metrics: readonly string[]
): Promise<DailyMetricRow[]> {
  if (!days.length) return [];
  const rows = (
    await database.query<{
      day: string;
      metric: string;
      dimensions: Record<string, unknown>;
      count: string;
      visitors: string;
    }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, metric, dimensions,
              count::bigint::text AS count, visitors::bigint::text AS visitors
         FROM (${dailyMetricsSql}) computed
        WHERE metric = ANY($3::text[])`,
      [days, timeZone, metrics]
    )
  ).rows;
  return rows.map((row) => ({
    day: row.day,
    metric: row.metric,
    dimensions: row.dimensions,
    count: Number(row.count),
    visitors: Number(row.visitors)
  }));
}

/** Replaces one day's stored rollup with rows computed from raw data. */
export async function storeDailyRollup(database: DatabaseReader, day: string, timeZone: string) {
  await database.query(
    "DELETE FROM analytics_daily WHERE day = $1::date AND metric <> ALL($2::text[])",
    [day, [rawPrunedMetric, collectDroppedMetric]]
  );
  await database.query(
    `INSERT INTO analytics_daily (day, metric, dimensions, count, visitors)
     SELECT day, metric, dimensions, count::bigint, visitors::bigint
       FROM (${dailyMetricsSql}) computed
     UNION ALL
     SELECT ($1::date[])[1], '${rollupMarkerMetric}', '{}'::jsonb, 1, 0`,
    [[day], timeZone]
  );
}
