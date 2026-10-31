import { logger } from "../core/logger.ts";

let reportedInvalidZone = "";

/**
 * Statistics use `TZ` for their day boundaries, the same zone that interprets
 * local image times (UTC when unset). Rolled-up days keep the zone they were
 * computed in when `TZ` changes later. An unknown zone would fail every
 * statistics query and stop rollups and pruning, so statistics count in UTC
 * and log the error until `TZ` is corrected; startup does not fail for it.
 * Offsets such as +08:00 count as unknown: Intl accepts them, but PostgreSQL
 * reads them as POSIX offsets with the opposite sign.
 */
export function analyticsTimeZone() {
  const zone = process.env.TZ || "UTC";
  try {
    if (!/^[A-Za-z]/u.test(zone)) throw new RangeError("not a time zone name");
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    if (reportedInvalidZone !== zone) {
      reportedInvalidZone = zone;
      logger.error("analytics_time_zone_invalid", { tz: zone, fallback: "UTC" });
    }
    return "UTC";
  }
}
