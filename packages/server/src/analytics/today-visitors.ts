import { pool } from "../core/database/pools.ts";
import { analyticsTimeZone } from "./time-zone.ts";

// The home page line is public and cached by CDNs for a minute; one database
// count per interval serves every request in between.
const refreshIntervalMs = 60_000;

let cached: { visitors: number; atMs: number } | null = null;
let pending: Promise<number> | null = null;

async function countTodayVisitors() {
  const result = await pool.query<{ visitors: string }>(
    `SELECT count(DISTINCT visitor_id)::text AS visitors
       FROM visit_event
      WHERE event = 'page_view'
        AND occurred_at >= (now() AT TIME ZONE $1)::date::timestamp AT TIME ZONE $1`,
    [analyticsTimeZone()]
  );
  return Number(result.rows[0]?.visitors ?? 0);
}

/** Distinct visitors of any public page (embeds included) since local midnight. */
export async function todayVisitors() {
  if (cached && Date.now() - cached.atMs < refreshIntervalMs) return cached.visitors;
  pending ??= countTodayVisitors()
    .then((visitors) => {
      cached = { visitors, atMs: Date.now() };
      return visitors;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

export function forgetTodayVisitors() {
  cached = null;
}
