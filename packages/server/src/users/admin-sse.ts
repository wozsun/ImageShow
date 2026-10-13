import { appConfig } from "@imageshow/shared";
import type { Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { setTimeout as delay } from "node:timers/promises";
import { raceWithAbortSignal } from "../core/abort.ts";
import type { AdminSession } from "../core/http/admin-session-context.ts";
import { logger } from "../core/logger.ts";
import { registerAdminSessionConnection } from "./admin-session-connections.ts";
import { validateAdminSessionById } from "./admin-session.ts";

export type AdminSseConnection = Readonly<{
  stream: SSEStreamingApi;
  /** Aborts when the client leaves, the session ends or the stream closes. */
  signal: AbortSignal;
  close: (reason: unknown) => void;
  /**
   * Runs after each periodic re-authentication that still matches the
   * session; a thrown error closes the stream.
   */
  onHeartbeat: (handler: () => void) => void;
}>;

function waitForHeartbeat(signal: AbortSignal, delayMs: number) {
  if (signal.aborted) return Promise.resolve(false);
  return delay(delayMs, true, { signal, ref: false }).catch((error: unknown) => {
    if (signal.aborted) return false;
    throw error;
  });
}

/**
 * One SSE response owned by an administrator session. It registers with the
 * session before the first validation, so a logout during that validation
 * still closes it; it re-validates on a heartbeat and releases the request,
 * session and heartbeat bindings when the handler ends.
 */
export function streamAdminSse(
  context: Context,
  input: Readonly<{
    session: AdminSession;
    /** Logged when the stream closes for a reason other than its own close. */
    closedEvent: string;
    logContext?: Readonly<Record<string, unknown>>;
    validateSession?: typeof validateAdminSessionById;
    authenticationHeartbeatMs?: number;
  }>,
  handle: (connection: AdminSseConnection) => Promise<void>
) {
  const validateSession = input.validateSession ?? validateAdminSessionById;
  const heartbeatMs = input.authenticationHeartbeatMs
    ?? appConfig.authentication.sseHeartbeatSeconds * 1_000;
  const sessionMatches = (current: AdminSession | null) =>
    current?.username === input.session.username
    && current.role === input.session.role;
  context.header("X-Accel-Buffering", "no");
  const response = streamSSE(context, async (stream) => {
    const controller = new AbortController();
    const close = (reason: unknown) => {
      if (!controller.signal.aborted) controller.abort(reason);
      if (!stream.closed && !stream.aborted) stream.abort();
    };
    const closeFromRequest = () =>
      close(context.req.raw.signal.reason ?? new Error("Admin SSE request closed"));
    context.req.raw.signal.addEventListener("abort", closeFromRequest, { once: true });
    stream.onAbort(closeFromRequest);
    if (context.req.raw.signal.aborted) closeFromRequest();
    const unregisterSession = registerAdminSessionConnection({
      sessionId: input.session.id,
      close: () => close(new Error("Administrator session invalidated"))
    });
    const authenticate = () =>
      raceWithAbortSignal(
        controller.signal,
        validateSession(input.session.id),
        "Admin SSE authentication aborted"
      );
    let heartbeat = () => {};
    let authentication: Promise<void> | undefined;
    try {
      controller.signal.throwIfAborted();
      if (!sessionMatches(await authenticate())) return;
      controller.signal.throwIfAborted();
      // Re-authentication is serial and independent of the handler's writes.
      authentication = (async () => {
        while (await waitForHeartbeat(controller.signal, heartbeatMs)) {
          if (!sessionMatches(await authenticate())) {
            close(new Error("Administrator session invalidated"));
            return;
          }
          heartbeat();
        }
      })().catch(close);
      await handle({
        stream,
        signal: controller.signal,
        close,
        onHeartbeat: (handler) => {
          heartbeat = handler;
        }
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        logger.warn(input.closedEvent, {
          ...input.logContext,
          owner: input.session.username,
          error
        });
      }
    } finally {
      close(new Error("Admin SSE closed"));
      unregisterSession();
      context.req.raw.signal.removeEventListener("abort", closeFromRequest);
      await authentication;
    }
  });
  response.headers.set("Cache-Control", "no-store, no-transform");
  return response;
}
