import "../support/server-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { streamIngestionQueueEvents } from "../../../packages/server/src/images/ingestion/queue/events.ts";
import { IngestionTokenService } from "../../../packages/server/src/images/ingestion/sessions/token-service.ts";
import type { IngestionQueueMutation } from "../../../packages/server/src/images/ingestion/repository.ts";
import { closeAdminSessionConnections } from "../../../packages/server/src/users/admin-session-connections.ts";

test("[Server/内容接入] SSE 慢读的各阶段持续串行验权，条数与字节超限释放连接", async (t) => {
  for (const stage of ["snapshot", "ready", "buffer", "live", "count", "bytes"] as const) {
    await t.test(stage, { timeout: 3_000 }, async () => {
      const session = { id: `sse-${stage}`, username: "owner", csrf: "csrf", role: "image" as const };
      const metadata = {
        owner: session.username, queue: "upload" as const, revision: 1, last_accepted_order: 1,
        total: 1, unfinished: 1, waiting: 0, running: 0, ready: 1, duplicate_pending: 0,
        committing_resolving: 0, resolving: 0, completed: 0, failed: 0
      };
      const mutation: IngestionQueueMutation = {
        owner: session.username, queue: "upload", kind: "removed", metadata,
        session: {
          owner: session.username, queue: "upload", session_id: "pair", image_id: "image",
          image_time: "time", request_hash: "a".repeat(64), status: "discarded", version: 1,
          last_semantic_revision: 1, accepted_at: 0, accepted_order: 1, discarded_at: 0, discard_at: 1
        }
      };
      let listener: ((mutation: IngestionQueueMutation) => void) | undefined;
      const subscribed = Promise.withResolvers<void>();
      const snapshot = Promise.withResolvers<{
        metadata: typeof metadata; offset: number; limit: number; items: []; staleItems: [];
      }>();
      let unsubscriptions = 0;
      let scopeCloses = 0;
      let validations = 0;
      let activeValidations = 0;
      let maximumValidations = 0;
      let valid = true;
      const app = new Hono();
      app.get("/events", (context) => streamIngestionQueueEvents(context, {
        session, queue: "upload", tokens: new IngestionTokenService({ rootKey: new Uint8Array(32).fill(1) }),
        repository: {
          subscribe(_owner, _queue, callback) {
            listener = callback;
            subscribed.resolve();
            return () => { unsubscriptions += 1; };
          },
          async snapshot() { return snapshot.promise; }
        },
        validateSession: async () => {
          activeValidations += 1;
          maximumValidations = Math.max(maximumValidations, activeValidations);
          await delay(2);
          validations += 1;
          activeValidations -= 1;
          return valid ? session : null;
        },
        authenticationHeartbeatMs: 5,
        actionScopes: {
          open: () => ({ id: "scope", connectionEpoch: 1, close: () => { scopeCloses += 1; } }),
          require: () => ({
            id: "scope", sessionId: session.id, owner: session.username, queue: "upload",
            connectionEpoch: 1, invalidate: () => undefined, replay: { bindings: new Map() }
          }),
          sign: () => "watermark"
        }
      }));
      const response = await app.request("/events");
      const reader = response.body!.getReader();
      const waitUntil = async (condition: () => boolean) => {
        const deadline = Date.now() + 800;
        while (!condition() && Date.now() < deadline) await delay(5);
        assert.ok(condition(), `${stage}: expected progress before deadline`);
      };
      try {
        await subscribed.promise;
        if (stage === "buffer") for (let i = 0; i < 20; i += 1) listener!(mutation);
        if (stage !== "snapshot") {
          snapshot.resolve({ metadata, offset: 0, limit: 0, items: [], staleItems: [] });
        }
        if (["buffer", "live", "count", "bytes"].includes(stage)) {
          assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/u);
        }
        if (["live", "count", "bytes"].includes(stage)) {
          assert.match(new TextDecoder().decode((await reader.read()).value), /event: ping/u);
        }
        if (stage === "live") for (let i = 0; i < 20; i += 1) listener!(mutation);
        if (stage === "count" || stage === "bytes") {
          const event = stage === "bytes"
            ? { ...mutation, session: { ...mutation.session!, session_id: "x".repeat(2 * 1024 * 1024) } }
            : mutation;
          // Publishing remains synchronous even when the reader stops consuming.
          for (let i = 0; i < (stage === "count" ? 2_000 : 1); i += 1) listener!(event);
        } else {
          const before = validations;
          await waitUntil(() => validations >= before + 3);
          valid = false;
        }
        await waitUntil(() => unsubscriptions === 1 && scopeCloses === 1);
        assert.equal(maximumValidations, 1);
        assert.equal(closeAdminSessionConnections([session.id]), 0);
        const afterClose = validations;
        listener!(mutation);
        await delay(25);
        assert.equal(validations, afterClose, "关闭后不再验权或接受发布");
        for (;;) { if ((await reader.read()).done) break; }
      } finally {
        closeAdminSessionConnections([session.id]);
        snapshot.resolve({ metadata, offset: 0, limit: 0, items: [], staleItems: [] });
        await reader.cancel();
      }
    });
  }
});
