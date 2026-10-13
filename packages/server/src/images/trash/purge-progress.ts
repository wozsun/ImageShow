import type { TrashPurgeProgressDto } from "@imageshow/shared/browser";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { setTimeout as delay } from "node:timers/promises";
import { raceWithAbortSignal } from "../../core/abort.ts";
import { pool } from "../../core/database/pools.ts";
import type { AdminSession } from "../../core/http/admin-session-context.ts";
import { logger } from "../../core/logger.ts";
import { registerAdminSessionConnection } from "../../users/admin-session-connections.ts";
import { validateAdminSessionById } from "../../users/admin-session.ts";

const authenticationHeartbeatMs = 30_000;
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
  context.header("X-Accel-Buffering", "no");
  const response = streamSSE(context, async (stream) => {
    const controller = new AbortController();
    let progressed = Promise.withResolvers<void>();
    const close = () => {
      if (!controller.signal.aborted) controller.abort();
      progressed.resolve();
    };
    const onProgress = () => progressed.resolve();
    context.req.raw.signal.addEventListener("abort", close, { once: true });
    stream.onAbort(close);
    if (context.req.raw.signal.aborted) close();
    const unregisterSession = registerAdminSessionConnection({
      sessionId: session.id,
      close
    });
    progressListeners.add(onProgress);
    const sameSession = (current: AdminSession | null) =>
      current?.username === session.username && current.role === session.role;
    try {
      let lastData = "";
      let lastReadAt = 0;
      let lastWriteAt = Date.now();
      let lastAuthenticatedAt = 0;
      while (!controller.signal.aborted) {
        if (Date.now() - lastAuthenticatedAt >= authenticationHeartbeatMs) {
          const current = await raceWithAbortSignal(
            controller.signal,
            validateAdminSessionById(session.id),
            "Trash purge progress authentication aborted"
          );
          if (!sameSession(current)) return;
          lastAuthenticatedAt = Date.now();
        }
        const spacingMs = minReadIntervalMs - (Date.now() - lastReadAt);
        if (spacingMs > 0) {
          await delay(spacingMs, undefined, { signal: controller.signal });
        }
        progressed = Promise.withResolvers<void>();
        lastReadAt = Date.now();
        const progress = await raceWithAbortSignal(
          controller.signal,
          readTrashPurgeProgress(),
          "Trash purge progress read aborted"
        );
        const data = JSON.stringify(progress);
        if (data !== lastData) {
          await stream.writeSSE({ event: "progress", data });
          lastData = data;
          lastWriteAt = Date.now();
        } else if (Date.now() - lastWriteAt >= authenticationHeartbeatMs) {
          await stream.writeSSE({ event: "ping", data: "{}" });
          lastWriteAt = Date.now();
        }
        if (!progress.pending) return;
        await waitForSignal(controller.signal, progressed.promise, idleReadIntervalMs);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        logger.warn("trash_purge_progress_sse_closed", {
          owner: session.username,
          error
        });
      }
    } finally {
      close();
      progressListeners.delete(onProgress);
      unregisterSession();
      context.req.raw.signal.removeEventListener("abort", close);
    }
  });
  response.headers.set("Cache-Control", "no-store, no-transform");
  return response;
}
