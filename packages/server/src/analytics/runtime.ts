import type { AnalyticsClearScope } from "@imageshow/shared/browser";
import { pool } from "../core/database/pools.ts";
import { logger } from "../core/logger.ts";
import { countCollectDrops, discardCollectDrops, writeCollectDrops } from "./collect-drops.ts";
import {
  addRandomApiCounts,
  discardRandomApiCounts,
  takeRandomApiCounts
} from "./random-api-counts.ts";
import {
  deleteAnalyticsData,
  pruneExpiredAnalytics,
  rollupFinishedDays
} from "./retention.ts";
import { analyticsTimeZone } from "./time-zone.ts";
import {
  discardBufferedVisitEvents,
  insertVisitEvents,
  takeVisitEventBatches,
  visitEventBatchReady
} from "./visit-events.ts";

const tickIntervalMs = 5_000;
const randomWriteIntervalMs = 60_000;
const maintenanceIntervalMs = 10 * 60_000;
const firstMaintenanceDelayMs = 60_000;

let timer: NodeJS.Timeout | undefined;
// Writes and clears run one at a time on this chain, so a clear can never be
// followed by a write of rows buffered before it.
let writes: Promise<void> = Promise.resolve();
let visitWriteQueued = false;
let randomWriteQueued = false;
let lastRandomWriteAtMs = 0;
let nextMaintenanceAtMs = 0;
let maintenance: Promise<void> | null = null;
let maintenanceAbort = new AbortController();
let clearing = 0;

function onWriteChain(task: () => Promise<void>) {
  const run = writes.then(task);
  writes = run.catch(() => undefined);
  return run;
}

async function writeVisitEvents() {
  visitWriteQueued = false;
  const { batches, dropped } = takeVisitEventBatches();
  if (dropped) {
    logger.warn("analytics_events_dropped", { reason: "buffer_full", events: dropped });
    countCollectDrops("buffer_full", dropped);
  }
  for (const batch of batches) {
    try {
      await insertVisitEvents(pool, batch);
    } catch (error) {
      logger.warn("analytics_events_dropped", { reason: "write_failed", events: batch.length, error });
      countCollectDrops("write_failed", batch.length);
    }
  }
  try {
    await writeCollectDrops(pool, analyticsTimeZone());
  } catch (error) {
    // Kept for the next write; the failed event writes above are already logged.
    logger.debug("analytics_drop_counts_deferred", { error });
  }
}

async function writeRandomApiCounts() {
  randomWriteQueued = false;
  lastRandomWriteAtMs = Date.now();
  const counts = takeRandomApiCounts();
  try {
    await addRandomApiCounts(pool, counts);
  } catch (error) {
    logger.warn("analytics_random_counts_dropped", { rows: counts.rows.length, error });
  }
}

function startMaintenance() {
  if (maintenance || clearing) return;
  nextMaintenanceAtMs = Date.now() + maintenanceIntervalMs;
  const signal = maintenanceAbort.signal;
  maintenance = (async () => {
    const rolledUp = await rollupFinishedDays(signal);
    const pruned = await pruneExpiredAnalytics(signal);
    logger.debug("analytics_maintenance", { rolled_up_days: rolledUp, ...pruned });
  })()
    .catch((error: unknown) => {
      if (!signal.aborted) logger.warn("analytics_maintenance_failed", { error });
    })
    .finally(() => {
      maintenance = null;
    });
}

function tick() {
  if (!visitWriteQueued) {
    visitWriteQueued = true;
    void onWriteChain(writeVisitEvents);
  }
  // A stalled database must not stack one queued write per tick.
  if (!randomWriteQueued && Date.now() - lastRandomWriteAtMs >= randomWriteIntervalMs) {
    randomWriteQueued = true;
    void onWriteChain(writeRandomApiCounts);
  }
  if (Date.now() >= nextMaintenanceAtMs) startMaintenance();
}

/** Called after buffering events; a full batch is written without waiting for the tick. */
export function noteBufferedVisitEvents() {
  if (!timer || visitWriteQueued || !visitEventBatchReady()) return;
  visitWriteQueued = true;
  void onWriteChain(writeVisitEvents);
}

export function startAnalyticsWriter() {
  if (timer) return;
  maintenanceAbort = new AbortController();
  lastRandomWriteAtMs = Date.now();
  nextMaintenanceAtMs = Date.now() + firstMaintenanceDelayMs;
  timer = setInterval(tick, tickIntervalMs);
}

export function stopAnalyticsWriter() {
  if (timer) clearInterval(timer);
  timer = undefined;
  maintenanceAbort.abort(new Error("Analytics writer stopping"));
}

/** Final write at shutdown after HTTP has stopped accepting requests. */
export async function drainAnalyticsWriter() {
  await maintenance;
  await onWriteChain(async () => {
    await writeVisitEvents();
    await writeRandomApiCounts();
  });
}

/**
 * Clears the scope after in-flight maintenance settles. Buffered rows of the
 * scope are discarded first, so nothing collected before the clear survives it.
 */
export async function clearAnalyticsData(scope: AnalyticsClearScope) {
  clearing += 1;
  try {
    await maintenance;
    await onWriteChain(async () => {
      if (scope !== "random") {
        discardBufferedVisitEvents();
        discardCollectDrops();
      }
      if (scope !== "visits") discardRandomApiCounts();
      await deleteAnalyticsData(scope);
    });
  } finally {
    clearing -= 1;
  }
}
