import { setTimeout as delay } from "node:timers/promises";
import { appConfig } from "@imageshow/shared";
import type {
  AdminImageListItemDto,
  CompletedServerIngestionItemDto,
  IngestionQueueEventDto,
  IngestionQueueTerminalEventItemDto
} from "@imageshow/shared/browser";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { raceWithAbortSignal } from "../../../core/abort.ts";
import { logger } from "../../../core/logger.ts";
import {
  registerAdminSessionConnection
} from "../../../users/admin-session-connections.ts";
import {
  validateAdminSessionById,
  type AdminSession
} from "../../../users/admin-session.ts";
import {
  openIngestionActionScope,
  requireIngestionActionScope,
  signIngestionActionWatermark
} from "./action-scope.ts";
import type {
  IngestionQueueType,
  StoredIngestionSession
} from "../sessions/model.ts";
import {
  IngestionSessionRepository,
  type IngestionQueueMutation
} from "../repository.ts";
import { presentIngestionQueueSummary } from "../sessions/projection.ts";
import { presentIngestionSession } from "./session-view.ts";
import type { IngestionTokenService } from "../sessions/token-service.ts";

const pendingEventLimit = 1_000;
const pendingByteLimit = 1024 * 1024;
type IngestionQueueEventRepository = Pick<
  IngestionSessionRepository,
  "snapshot" | "subscribe"
>;
type IngestionQueueActionScopes = Readonly<{
  open: typeof openIngestionActionScope;
  require: typeof requireIngestionActionScope;
  sign: typeof signIngestionActionWatermark;
}>;

const defaultActionScopes: IngestionQueueActionScopes = {
  open: openIngestionActionScope,
  require: requireIngestionActionScope,
  sign: signIngestionActionWatermark
};

function terminalEventItem(
  session: Extract<StoredIngestionSession, { status: "completed" | "discarded" }>
): IngestionQueueTerminalEventItemDto {
  return {
    session_id: session.session_id,
    image_id: session.image_id,
    status: session.status,
    version: session.version,
    progress_seq: 0,
    last_semantic_revision: session.last_semantic_revision,
    accepted_at: session.accepted_at,
    accepted_order: session.accepted_order
  };
}

function completedEventItem(
  session: Extract<StoredIngestionSession, { status: "completed" }>,
  completedItem: AdminImageListItemDto
): CompletedServerIngestionItemDto {
  return {
    ...terminalEventItem(session),
    queue: session.queue,
    status: "completed",
    completed_at: session.completed_at,
    ...(session.display ? { display: session.display } : {}),
    completed_item: completedItem
  };
}

function eventSession(
  session: StoredIngestionSession,
  completedItem?: AdminImageListItemDto
) {
  if (session.status === "completed" && completedItem) {
    return completedEventItem(session, completedItem);
  }
  return session.status === "completed" || session.status === "discarded"
    ? terminalEventItem(session)
    : presentIngestionSession(session);
}

function waitForHeartbeat(signal: AbortSignal, delayMs: number) {
  if (signal.aborted) return Promise.resolve(false);
  return delay(delayMs, true, { signal, ref: false }).catch((error: unknown) => {
    if (signal.aborted) return false;
    throw error;
  });
}

/** One authenticated, owner-scoped SSE connection for one Ingestion queue. */
export function streamIngestionQueueEvents(
  context: Context,
  input: Readonly<{
    repository: IngestionQueueEventRepository;
    tokens: IngestionTokenService;
    session: AdminSession;
    queue: IngestionQueueType;
    validateSession?: typeof validateAdminSessionById;
    authenticationHeartbeatMs?: number;
    actionScopes?: IngestionQueueActionScopes;
  }>
) {
  const validateSession = input.validateSession ?? validateAdminSessionById;
  const actionScopes = input.actionScopes ?? defaultActionScopes;
  const authenticationHeartbeatMs = input.authenticationHeartbeatMs
    ?? appConfig.ingestionRuntime.sseAuthenticationHeartbeatSeconds * 1_000;
  context.header("X-Accel-Buffering", "no");
  const response = streamSSE(context, async (stream) => {
    const controller = new AbortController();
    const pending: Array<{ event: string; data: string; bytes: number }> = [];
    let pendingCount = 0;
    let pendingBytes = 0;
    let wakeWriter = Promise.withResolvers<void>();
    let authentication: Promise<void> | undefined;
    const close = (reason: unknown) => {
      if (!controller.signal.aborted) controller.abort(reason);
      wakeWriter.resolve();
      if (!stream.closed && !stream.aborted) stream.abort();
    };
    const closeFromRequest = () => close(
      context.req.raw.signal.reason ?? new Error("Ingestion SSE request closed")
    );
    context.req.raw.signal.addEventListener("abort", closeFromRequest, { once: true });
    stream.onAbort(closeFromRequest);
    if (context.req.raw.signal.aborted) closeFromRequest();
    let unsubscribeQueue: () => void = () => undefined;
    let unregisterSession: () => void = () => undefined;
    let closeScope: () => void = () => undefined;
    const enqueue = (event: string, payload: IngestionQueueEventDto, first = false) => {
      if (controller.signal.aborted) return;
      const data = JSON.stringify(payload);
      const bytes = Buffer.byteLength(`event: ${event}\ndata: ${data}\n\n`);
      // Include the in-flight write and the pre-snapshot buffer in one budget.
      if (pendingCount >= pendingEventLimit || pendingBytes + bytes > pendingByteLimit) {
        close(new Error("Ingestion SSE pending event budget exceeded"));
        return;
      }
      const item = { event, data, bytes };
      if (first) pending.unshift(item);
      else pending.push(item);
      pendingCount += 1;
      pendingBytes += bytes;
      wakeWriter.resolve();
    };
    const sessionMatches = (session: AdminSession | null) => session
      && session.username === input.session.username
      && session.role === input.session.role;

    try {
      controller.signal.throwIfAborted();
      unregisterSession = registerAdminSessionConnection({
        sessionId: input.session.id,
        close: () => close(new Error("Administrator session invalidated"))
      });
      const validated = await raceWithAbortSignal(
        controller.signal,
        validateSession(input.session.id),
        "Ingestion SSE authentication aborted"
      );
      if (!sessionMatches(validated)) return;
      controller.signal.throwIfAborted();
      const scope = actionScopes.open(
        input.session,
        input.queue,
        () => close(new Error("Ingestion action scope invalidated"))
      );
      closeScope = scope.close;
      const requireScope = () => actionScopes.require({
        id: scope.id,
        sessionId: input.session.id,
        owner: input.session.username,
        queue: input.queue
      });
      let readySent = false;
      // Authentication is serial but independent of snapshot and socket writes.
      authentication = (async () => {
        while (await waitForHeartbeat(controller.signal, authenticationHeartbeatMs)) {
          const current = await raceWithAbortSignal(
            controller.signal,
            validateSession(input.session.id),
            "Ingestion SSE authentication aborted"
          );
          if (!sessionMatches(current)) {
            close(new Error("Administrator session invalidated"));
            return;
          }
          requireScope();
          if (readySent) enqueue("ping", { type: "ping", queue: input.queue });
        }
      })().catch(close);
      const emitMutation = (mutation: IngestionQueueMutation) => {
        if (controller.signal.aborted) return;
        try {
          if (!mutation.session) {
            throw new Error("Ingestion queue mutation omitted its session identity");
          }
          enqueue("mutation", {
            type: "mutation",
            queue: input.queue,
            kind: mutation.kind,
            revision: mutation.metadata.revision,
            last_accepted_order: mutation.metadata.last_accepted_order,
            summary: presentIngestionQueueSummary(mutation.metadata),
            session: eventSession(mutation.session, mutation.completedItem),
            ...(mutation.kind === "progress" ? {} : {
              action_watermark: actionScopes.sign(requireScope(), mutation.metadata, input.tokens)
            })
          });
        } catch (error) {
          close(error);
        }
      };
      unsubscribeQueue = input.repository.subscribe(
        input.session.username, input.queue, emitMutation
      );
      const initial = await raceWithAbortSignal(
        controller.signal,
        input.repository.snapshot(input.session.username, input.queue, 0, 0),
        "Ingestion SSE initial snapshot aborted"
      );
      requireScope();
      enqueue("ready", {
        type: "ready",
        queue: input.queue,
        revision: initial.metadata.revision,
        action_scope: scope.id
      }, true);
      while (!controller.signal.aborted) {
        const next = pending.shift();
        if (!next) {
          wakeWriter = Promise.withResolvers<void>();
          await wakeWriter.promise;
          continue;
        }
        try {
          await raceWithAbortSignal(
            controller.signal,
            stream.writeSSE(next),
            "Ingestion SSE write aborted"
          );
          if (next.event === "ready") readySent = true;
        } finally {
          pendingCount -= 1;
          pendingBytes -= next.bytes;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        logger.warn("ingestion_queue_sse_closed", {
          owner: input.session.username,
          queue: input.queue,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      close(new Error("Ingestion SSE closed"));
      pending.length = 0;
      unsubscribeQueue();
      unregisterSession();
      closeScope();
      context.req.raw.signal.removeEventListener("abort", closeFromRequest);
      await authentication;
    }
  });
  response.headers.set("Cache-Control", "no-store, no-transform");
  return response;
}
