import type { PoolClient } from "pg";
import { analyticsEventsOfTier, type AnalyticsClearScope } from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { pool } from "../core/database/pools.ts";
import { logger } from "../core/logger.ts";
import { withTransactionOnClient } from "../core/database/transactions.ts";
import { randomApiMetrics, rawPrunedMetric, rollupMarkerMetric, storeDailyRollup } from "./daily-metrics.ts";
import { analyticsTimeZone } from "./time-zone.ts";

// An hour bucket that starts before local midnight ends up to an hour later in
// zones with fractional offsets, and its counts arrive up to a minute after it
// ends; a day is rolled up only after this grace has passed its end.
const rollupGraceMinutes = 75;
const pruneBatchSize = 5_000;

async function inTransaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await withTransactionOnClient(client, work);
  } finally {
    client.release();
  }
}

/**
 * Rolls up every finished local day that has no rollup yet, oldest first,
 * from the later of the day after the latest pruning and the oldest raw row.
 * Rollups run before pruning, so days missed while the process was stopped
 * are recovered from complete raw rows whatever the retention, and a day
 * whose visit rows were partly pruned is never stored as complete (the
 * interaction tier leaves no marker). Rerunning a day replaces
 * its rows. A day that fails is retried next time and does not hold back
 * later days.
 */
export async function rollupFinishedDays(signal: AbortSignal) {
  const timeZone = analyticsTimeZone();
  const days = (
    await pool.query<{ day: string }>(
      `SELECT to_char(series.day, 'YYYY-MM-DD') AS day
         FROM generate_series(
                greatest(
                  (SELECT max(day) FROM analytics_daily WHERE metric = $4) + 1,
                  (least(
                    (SELECT min(occurred_at) FROM visit_event),
                    (SELECT min(hour) FROM random_api_hourly)
                  ) AT TIME ZONE $1)::date
                ),
                ((now() - make_interval(mins => $2)) AT TIME ZONE $1)::date - 1,
                interval '1 day'
              ) AS series(day)
        WHERE NOT EXISTS (
          SELECT 1 FROM analytics_daily stored
           WHERE stored.day = series.day::date AND stored.metric = $3
        )
        ORDER BY series.day`,
      [timeZone, rollupGraceMinutes, rollupMarkerMetric, rawPrunedMetric]
    )
  ).rows.map((row) => row.day);
  let rolledUp = 0;
  for (const day of days) {
    signal.throwIfAborted();
    try {
      await inTransaction((client) => storeDailyRollup(client, day, timeZone));
      rolledUp += 1;
    } catch (error) {
      if (signal.aborted) throw error;
      logger.warn("analytics_rollup_failed", { day, error });
    }
  }
  return rolledUp;
}

async function deleteInBatches(sql: string, parameters: unknown[], signal: AbortSignal) {
  let deleted = 0;
  for (;;) {
    signal.throwIfAborted();
    const removed = (await pool.query(sql, parameters)).rowCount ?? 0;
    deleted += removed;
    if (removed < pruneBatchSize) return deleted;
  }
}

/**
 * When a tier's raw rows older than its retention are deleted, or null for a
 * retention of 0, which keeps them. Rows of the local day before today are
 * never deleted, so a one-day retention still lets the running process roll
 * yesterday up first.
 */
async function pruneBefore(days: number, timeZone: string) {
  if (days === 0) return null;
  return (
    await pool.query<{ cutoff: Date }>(
      `SELECT least(
                now() - make_interval(days => $1),
                ((now() AT TIME ZONE $2)::date - 1)::timestamp AT TIME ZONE $2
              ) AS cutoff`,
      [days, timeZone]
    )
  ).rows[0]!.cutoff;
}

/**
 * Deletes raw rows past their tier's retention; daily rollups stay forever.
 * Every event outside the visit tier is an interaction, including events a
 * later version no longer collects.
 */
export async function pruneExpiredAnalytics(signal: AbortSignal) {
  const retention = getRuntimeConfig().analytics;
  const timeZone = analyticsTimeZone();
  const visitsBefore = await pruneBefore(retention.visit_retention_days, timeZone);
  const interactionsBefore = await pruneBefore(retention.interaction_retention_days, timeZone);
  if (visitsBefore) {
    // Recorded before deleting: the last day rows may be deleted from, so a
    // cutoff at local midnight marks the day before. A shorter retention used
    // earlier keeps the later day.
    await pool.query(
      `INSERT INTO analytics_daily (day, metric, dimensions, count, visitors)
       VALUES ((($2::timestamptz - interval '1 microsecond') AT TIME ZONE $3)::date, $1, '{}'::jsonb, 0, 0)
       ON CONFLICT DO NOTHING`,
      [rawPrunedMetric, visitsBefore, timeZone]
    );
    await pool.query(
      `DELETE FROM analytics_daily
        WHERE metric = $1 AND day < (SELECT max(day) FROM analytics_daily WHERE metric = $1)`,
      [rawPrunedMetric]
    );
  }
  const expiredEvents = (tierCondition: string) => `DELETE FROM visit_event
     WHERE ctid = ANY(ARRAY(
       SELECT ctid FROM visit_event
        WHERE ${tierCondition}
          AND occurred_at < $2::timestamptz
        LIMIT ${pruneBatchSize}
     ))`;
  const visitEvents = analyticsEventsOfTier("visit");
  const visits = visitsBefore
    ? await deleteInBatches(
        expiredEvents("event = ANY($1::text[])"),
        [visitEvents, visitsBefore],
        signal
      )
    : 0;
  const interactions = interactionsBefore
    ? await deleteInBatches(
        expiredEvents("event <> ALL($1::text[])"),
        [visitEvents, interactionsBefore],
        signal
      )
    : 0;
  let randomHours = 0;
  if (visitsBefore) {
    for (const table of ["random_api_hourly", "random_api_option_hourly"]) {
      randomHours += await deleteInBatches(
        `DELETE FROM ${table}
          WHERE ctid = ANY(ARRAY(
            SELECT ctid FROM ${table}
             WHERE hour < $1::timestamptz
             LIMIT ${pruneBatchSize}
          ))`,
        [visitsBefore],
        signal
      );
    }
  }
  return { visits, interactions, randomHours };
}

/** Deletes the scope's raw rows and rollups in one transaction. */
export async function deleteAnalyticsData(scope: AnalyticsClearScope) {
  await inTransaction(async (client) => {
    if (scope === "all") {
      await client.query("DELETE FROM visit_event");
      await client.query("DELETE FROM random_api_hourly");
      await client.query("DELETE FROM random_api_option_hourly");
      await client.query("DELETE FROM analytics_daily");
      return;
    }
    if (scope === "visits") {
      await client.query("DELETE FROM visit_event");
      await client.query(
        "DELETE FROM analytics_daily WHERE metric <> ALL($1::text[])",
        [[rollupMarkerMetric, rawPrunedMetric, ...randomApiMetrics]]
      );
      return;
    }
    await client.query("DELETE FROM random_api_hourly");
    await client.query("DELETE FROM random_api_option_hourly");
    await client.query(
      "DELETE FROM analytics_daily WHERE metric = ANY($1::text[])",
      [randomApiMetrics]
    );
  });
}
