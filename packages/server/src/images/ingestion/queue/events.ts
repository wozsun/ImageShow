import { packImageAddresses } from "@imageshow/shared/browser";
import type {
  CompletedIngestionImageDto,
  CompletedServerIngestionItemDto,
  IngestionQueueEventDto,
  IngestionQueueTerminalEventItemDto
} from "@imageshow/shared/browser";
import type { Context } from "hono";
import { raceWithAbortSignal } from "../../../core/abort.ts";
import type { AdminSession } from "../../../core/http/admin-session-context.ts";
import type { validateAdminSessionById } from "../../../users/admin-session.ts";
import { streamAdminSse } from "../../../users/admin-sse.ts";
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
type IngestionQueueEventRepository = Pick<IngestionSessionRepository, "snapshot" | "subscribe">;
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
    accepted_order: session.accepted_order
  };
}

function completedEventItem(
  session: Extract<StoredIngestionSession, { status: "completed" }>,
  completedItem: CompletedIngestionImageDto
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
  completedItem?: CompletedIngestionImageDto
) {
  if (session.status === "completed" && completedItem) {
    return completedEventItem(session, completedItem);
  }
  return session.status === "completed" || session.status === "discarded"
    ? terminalEventItem(session)
    : presentIngestionSession(session);
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
  const actionScopes = input.actionScopes ?? defaultActionScopes;
  return streamAdminSse(
    context,
    {
      session: input.session,
      closedEvent: "ingestion_queue_sse_closed",
      logContext: { queue: input.queue },
      validateSession: input.validateSession,
      authenticationHeartbeatMs: input.authenticationHeartbeatMs
    },
    async ({ stream, signal, close, onHeartbeat }) => {
      const pending: Array<{ event: string; data: string; bytes: number }> = [];
      let pendingCount = 0;
      let pendingBytes = 0;
      let wakeWriter = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => wakeWriter.resolve(), { once: true });
      let unsubscribeQueue: () => void = () => undefined;
      let closeScope: () => void = () => undefined;
      const enqueue = (event: string, payload: IngestionQueueEventDto, first = false) => {
        if (signal.aborted) return;
        const data = JSON.stringify(packImageAddresses(payload));
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

      try {
        const scope = actionScopes.open(input.session, input.queue, () =>
          close(new Error("Ingestion action scope invalidated"))
        );
        closeScope = scope.close;
        const requireScope = () =>
          actionScopes.require({
            id: scope.id,
            sessionId: input.session.id,
            owner: input.session.username,
            queue: input.queue
          });
        let readySent = false;
        onHeartbeat(() => {
          requireScope();
          if (readySent) enqueue("ping", { type: "ping", queue: input.queue });
        });
        const emitMutation = (mutation: IngestionQueueMutation) => {
          if (signal.aborted) return;
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
              ...(mutation.kind === "progress"
                ? {}
                : {
                    action_watermark: actionScopes.sign(
                      requireScope(),
                      mutation.metadata,
                      input.tokens
                    )
                  })
            });
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
          signal,
          input.repository.snapshot(input.session.username, input.queue, 0, 0),
          "Ingestion SSE initial snapshot aborted"
        );
        requireScope();
        enqueue(
          "ready",
          {
            type: "ready",
            queue: input.queue,
            revision: initial.metadata.revision,
            action_scope: scope.id
          },
          true
        );
        while (!signal.aborted) {
          const next = pending.shift();
          if (!next) {
            wakeWriter = Promise.withResolvers<void>();
            await wakeWriter.promise;
            continue;
          }
          try {
            await raceWithAbortSignal(
              signal,
              stream.writeSSE(next),
              "Ingestion SSE write aborted"
            );
            if (next.event === "ready") readySent = true;
          } finally {
            pendingCount -= 1;
            pendingBytes -= next.bytes;
          }
        }
      } finally {
        pending.length = 0;
        unsubscribeQueue();
        closeScope();
      }
    }
  );
}
