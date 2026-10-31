import type { AnalyticsCollectDropReason } from "@imageshow/shared/browser";
import type { DatabaseReader } from "../core/database/pools.ts";
import { collectDroppedMetric } from "./daily-metrics.ts";

let pending = new Map<AnalyticsCollectDropReason, number>();

/** Counts reports dropped for a reason: requests for the per-IP limit, events otherwise. */
export function countCollectDrops(reason: AnalyticsCollectDropReason, amount: number) {
  if (amount > 0) pending.set(reason, (pending.get(reason) ?? 0) + amount);
}

export function discardCollectDrops() {
  pending = new Map();
}

/**
 * Adds the drops counted so far to today's totals. A failed write keeps them
 * for the next one, so a database outage is counted once it recovers.
 */
export async function writeCollectDrops(database: DatabaseReader, timeZone: string) {
  if (!pending.size) return;
  const taken = pending;
  pending = new Map();
  try {
    await database.query(
      `INSERT INTO analytics_daily (day, metric, dimensions, count, visitors)
       SELECT (now() AT TIME ZONE $1)::date, $2, jsonb_build_object('reason', dropped.reason), dropped.amount, 0
         FROM unnest($3::text[], $4::bigint[]) AS dropped(reason, amount)
       ON CONFLICT (day, metric, dimensions)
       DO UPDATE SET count = analytics_daily.count + excluded.count`,
      [timeZone, collectDroppedMetric, [...taken.keys()], [...taken.values()]]
    );
  } catch (error) {
    for (const [reason, amount] of taken) countCollectDrops(reason, amount);
    throw error;
  }
}
