import {
  analyticsDirectHost,
  analyticsOtherHost,
  type RandomApiStatusClass
} from "@imageshow/shared/browser";
import type { DatabaseReader } from "../core/database/pools.ts";

export type RandomApiCall = {
  at: number;
  mode: string;
  method: "GET" | "HEAD";
  statusClass: RandomApiStatusClass;
  trusted: boolean;
  referrerHost: string;
  images: number;
  /** Until the response headers, without transferring an image. */
  durationMs: number;
  /** Query parameters the call used, each with a bounded value. */
  options: readonly RandomApiOption[];
};

export type RandomApiOption = { option: string; value: string };

type RandomApiCount = Omit<RandomApiCall, "at" | "images" | "durationMs" | "options"> & {
  hour: Date;
  requests: number;
  images: number;
  durationMsSum: number;
  durationMsMax: number;
};

type RandomApiOptionCount = RandomApiOption & { hour: Date; requests: number };

const hourMs = 60 * 60 * 1000;
// Referer hosts are client-controlled. Hosts beyond this many per hour share
// one row so a flood of invented hosts cannot grow memory or the hourly table.
const hostsPerHour = 200;

let counts = new Map<string, RandomApiCount>();
let optionCounts = new Map<string, RandomApiOptionCount>();
let hostsByHour = new Map<number, Set<string>>();

export function countRandomApiCall(call: RandomApiCall) {
  const hourStart = Math.floor(call.at / hourMs) * hourMs;
  let hosts = hostsByHour.get(hourStart);
  if (!hosts) {
    hosts = new Set();
    hostsByHour.set(hourStart, hosts);
  }
  let referrerHost = call.referrerHost;
  if (referrerHost !== analyticsDirectHost && !hosts.has(referrerHost)) {
    if (hosts.size < hostsPerHour) hosts.add(referrerHost);
    else referrerHost = analyticsOtherHost;
  }
  for (const { option, value } of call.options) {
    const optionKey = JSON.stringify([hourStart, option, value]);
    const counted = optionCounts.get(optionKey);
    if (counted) counted.requests += 1;
    else optionCounts.set(optionKey, { hour: new Date(hourStart), option, value, requests: 1 });
  }
  const key = JSON.stringify([
    hourStart,
    call.mode,
    call.method,
    call.statusClass,
    call.trusted,
    referrerHost
  ]);
  const current = counts.get(key);
  if (current) {
    current.requests += 1;
    current.images += call.images;
    current.durationMsSum += call.durationMs;
    current.durationMsMax = Math.max(current.durationMsMax, call.durationMs);
    return;
  }
  counts.set(key, {
    hour: new Date(hourStart),
    mode: call.mode,
    method: call.method,
    statusClass: call.statusClass,
    trusted: call.trusted,
    referrerHost,
    requests: 1,
    images: call.images,
    durationMsSum: call.durationMs,
    durationMsMax: call.durationMs
  });
}

export function discardRandomApiCounts() {
  counts = new Map();
  optionCounts = new Map();
  hostsByHour = new Map();
}

/**
 * Takes the accumulated counts; calls arriving later start a new accumulation.
 * The per-hour host sets outlive the take so the cap holds for the whole hour.
 */
export function takeRandomApiCounts() {
  const taken = { rows: [...counts.values()], options: [...optionCounts.values()] };
  counts = new Map();
  optionCounts = new Map();
  const currentHour = Math.floor(Date.now() / hourMs) * hourMs;
  for (const hour of hostsByHour.keys()) {
    if (hour < currentHour - hourMs) hostsByHour.delete(hour);
  }
  return taken;
}

/** Adds both tables' counts in one statement, so they are kept or lost together. */
export async function addRandomApiCounts(
  database: DatabaseReader,
  { rows, options }: ReturnType<typeof takeRandomApiCounts>
) {
  if (!rows.length) return;
  await database.query(
    `WITH calls AS (
       INSERT INTO random_api_hourly (
         hour, mode, method, status_class, trusted, referrer_host, requests, images,
         duration_ms_sum, duration_ms_max
       )
       SELECT *
         FROM unnest(
           $1::timestamptz[], $2::text[], $3::text[], $4::text[],
           $5::boolean[], $6::text[], $7::bigint[], $8::bigint[],
           $9::bigint[], $10::integer[]
         )
       ON CONFLICT (hour, mode, method, status_class, trusted, referrer_host)
       DO UPDATE SET requests = random_api_hourly.requests + excluded.requests,
                     images = random_api_hourly.images + excluded.images,
                     duration_ms_sum = random_api_hourly.duration_ms_sum + excluded.duration_ms_sum,
                     duration_ms_max = greatest(random_api_hourly.duration_ms_max, excluded.duration_ms_max)
     )
     INSERT INTO random_api_option_hourly (hour, option, value, requests)
     SELECT * FROM unnest($11::timestamptz[], $12::text[], $13::text[], $14::bigint[])
     ON CONFLICT (hour, option, value)
     DO UPDATE SET requests = random_api_option_hourly.requests + excluded.requests`,
    [
      rows.map((row) => row.hour),
      rows.map((row) => row.mode),
      rows.map((row) => row.method),
      rows.map((row) => row.statusClass),
      rows.map((row) => row.trusted),
      rows.map((row) => row.referrerHost),
      rows.map((row) => row.requests),
      rows.map((row) => row.images),
      rows.map((row) => row.durationMsSum),
      rows.map((row) => row.durationMsMax),
      options.map((row) => row.hour),
      options.map((row) => row.option),
      options.map((row) => row.value),
      options.map((row) => row.requests)
    ]
  );
}
