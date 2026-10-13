import type { TrashPurgeProgressDto } from "@imageshow/shared/browser";
import type { Context } from "hono";
import { setTimeout as delay } from "node:timers/promises";
import { raceWithAbortSignal } from "../../core/abort.ts";
import { pool } from "../../core/database/pools.ts";
import type { AdminSession } from "../../core/http/admin-session-context.ts";
import { streamAdminSse } from "../../users/admin-sse.ts";

const minReadIntervalMs = 200;
// A failed attempt settles after its handler returns, so no completion signal
// follows the last job; an idle re-read observes that settlement.
const idleReadIntervalMs = 1_000;

// Purge jobs and progress streams share the single app process. Signals only
// shorten the wait for the next read; PostgreSQL stays the authority.
const progressListeners = new Set<() => void>();

export function notifyTrashPurgeProgress() {
  for (const listener of progressListeners) listener();
}

export async function readTrashPurgeProgress(): Promise<TrashPurgeProgressDto> {
  const row = (
    await pool.query(
      `SELECT count(*) FILTER (WHERE job.status IN ('pending', 'running'))::int AS pending,
              count(*) FILTER (WHERE job.status='failed')::int AS failed
         FROM background_job job
         JOIN metadata ON metadata.id=job.target_id::uuid
        WHERE job.type='trash.purge'
          AND job.status IN ('pending', 'running', 'failed')`
    )
  ).rows[0] as Record<string, unknown> | undefined;
  return {
    pending: Number(row?.pending ?? 0),
    failed: Number(row?.failed ?? 0)
  };
}

function waitForSignal(
  signal: AbortSignal,
  progressed: Promise<void>,
  delayMs: number
) {
  return Promise.race([
    progressed,
    delay(delayMs, undefined, { signal, ref: false }).catch(() => undefined)
  ]);
}

/**
 * One session-scoped stream of the global purge state. It sends the current
 * state at once and ends after the first state without pending work, so an
 * idle trash view costs a single short request.
 */
export function streamTrashPurgeProgress(context: Context, session: AdminSession) {
  return streamAdminSse(
    context,
    { session, closedEvent: "trash_purge_progress_sse_closed" },
    async ({ stream, signal, onHeartbeat }) => {
      let progressed = Promise.withResolvers<void>();
      const onProgress = () => progressed.resolve();
      signal.addEventListener("abort", onProgress, { once: true });
      progressListeners.add(onProgress);
      onHeartbeat(() => {
        void stream.writeSSE({ event: "ping", data: "{}" }).catch(() => undefined);
      });
      try {
        let lastData = "";
        let lastReadAt = 0;
        while (!signal.aborted) {
          const spacingMs = minReadIntervalMs - (Date.now() - lastReadAt);
          if (spacingMs > 0) {
            await delay(spacingMs, undefined, { signal });
          }
          progressed = Promise.withResolvers<void>();
          lastReadAt = Date.now();
          const progress = await raceWithAbortSignal(
            signal,
            readTrashPurgeProgress(),
            "Trash purge progress read aborted"
          );
          const data = JSON.stringify(progress);
          if (data !== lastData) {
            await stream.writeSSE({ event: "progress", data });
            lastData = data;
          }
          if (!progress.pending) return;
          await waitForSignal(signal, progressed.promise, idleReadIntervalMs);
        }
      } finally {
        progressListeners.delete(onProgress);
      }
    }
  );
}
