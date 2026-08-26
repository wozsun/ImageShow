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

const initialMutationBufferLimit = 1_000;
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
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(
      () => finish(true),
      delayMs
    );
    timer.unref();
    const onAbort = () => finish(false);
    const finish = (elapsed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(elapsed);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** One authenticated, owner-scoped SSE connection for one import queue. */
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
    const close = (reason: unknown) => {
      if (!controller.signal.aborted) controller.abort(reason);
      if (!stream.closed && !stream.aborted) stream.abort();
    };
    const closeFromRequest = () => close(
      context.req.raw.signal.reason ?? new Error("Import SSE request closed")
    );
    context.req.raw.signal.addEventListener("abort", closeFromRequest, {
      once: true
    });
    stream.onAbort(closeFromRequest);
    let unsubscribeQueue: () => void = () => undefined;
    let unregisterSession: () => void = () => undefined;
    let closeScope: () => void = () => undefined;
    let writes = Promise.resolve();
    const enqueue = (event: string, payload: IngestionQueueEventDto) => {
      const write = writes.then(async () => {
        controller.signal.throwIfAborted();
        await raceWithAbortSignal(
          controller.signal,
          stream.writeSSE({ event, data: JSON.stringify(payload) }),
          "Import SSE write aborted"
        );
      });
      writes = write.catch((error) => close(error));
      return write;
    };

    try {
      unregisterSession = registerAdminSessionConnection({
        sessionId: input.session.id,
        close: () => close(new Error("Administrator session invalidated"))
      });
      const validated = await raceWithAbortSignal(
        controller.signal,
        validateSession(input.session.id),
        "Import SSE authentication aborted"
      );
      if (
        !validated
        || validated.username !== input.session.username
        || validated.role !== input.session.role
      ) return;
      controller.signal.throwIfAborted();
      const scope = actionScopes.open(
        input.session,
        input.queue,
        () => close(new Error("Import action scope invalidated"))
      );
      closeScope = scope.close;

      let readySent = false;
      let initialOverflow = false;
      const buffered: IngestionQueueMutation[] = [];
      const mutationPayload = (mutation: IngestionQueueMutation) => {
        if (!mutation.session) {
          throw new Error("Import queue mutation omitted its session identity");
        }
        const payload: IngestionQueueEventDto = {
          type: "mutation",
          queue: input.queue,
          kind: mutation.kind,
          revision: mutation.metadata.revision,
          last_accepted_order: mutation.metadata.last_accepted_order,
          summary: presentIngestionQueueSummary(mutation.metadata),
          session: eventSession(mutation.session, mutation.completedItem),
          ...(mutation.kind === "progress"
            ? {}
            : {
                action_watermark: actionScopes.sign(
                  actionScopes.require({
                    id: scope.id,
                    sessionId: input.session.id,
                    owner: input.session.username,
                    queue: input.queue
                  }),
                  mutation.metadata,
                  input.tokens
                )
              })
        };
        return payload;
      };
      const emitMutation = (mutation: IngestionQueueMutation) => {
        if (!readySent) {
          if (buffered.length >= initialMutationBufferLimit) {
            initialOverflow = true;
            close(new Error("Import SSE initial mutation buffer overflow"));
          } else {
            buffered.push(mutation);
          }
          return;
        }
        try {
          void enqueue("mutation", mutationPayload(mutation)).catch(close);
        } catch (error) {
          close(error);
        }
      };
      unsubscribeQueue = input.repository.subscribe(
        input.session.username,
        input.queue,
        emitMutation
      );
      const initial = await raceWithAbortSignal(
        controller.signal,
        input.repository.snapshot(
          input.session.username,
          input.queue,
          0,
          0
        ),
        "Import SSE initial snapshot aborted"
      );
      actionScopes.require({
        id: scope.id,
        sessionId: input.session.id,
        owner: input.session.username,
        queue: input.queue
      });
      await enqueue("ready", {
        type: "ready",
        queue: input.queue,
        revision: initial.metadata.revision,
        action_scope: scope.id
      });
      while (buffered.length && !controller.signal.aborted) {
        const batch = buffered.splice(0);
        for (const mutation of batch) {
          await enqueue("mutation", mutationPayload(mutation));
        }
      }
      if (initialOverflow || controller.signal.aborted) return;
      readySent = true;

      while (await waitForHeartbeat(
        controller.signal,
        authenticationHeartbeatMs
      )) {
        const heartbeatSession = await raceWithAbortSignal(
          controller.signal,
          validateSession(input.session.id),
          "Import SSE authentication aborted"
        );
        if (
          !heartbeatSession
          || heartbeatSession.username !== input.session.username
          || heartbeatSession.role !== input.session.role
        ) break;
        actionScopes.require({
          id: scope.id,
          sessionId: input.session.id,
          owner: input.session.username,
          queue: input.queue
        });
        await enqueue("ping", { type: "ping", queue: input.queue });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        logger.warn("import_queue_sse_closed", {
          owner: input.session.username,
          queue: input.queue,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      if (!controller.signal.aborted) {
        controller.abort(new Error("Import SSE closed"));
      }
      unsubscribeQueue();
      unregisterSession();
      closeScope();
      context.req.raw.signal.removeEventListener("abort", closeFromRequest);
      await writes.catch(() => undefined);
    }
  });
  response.headers.set("Cache-Control", "no-store, no-transform");
  return response;
}
