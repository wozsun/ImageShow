import assert from "node:assert/strict";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { listenForFetch } from "../../support/http-listen.ts";
import {
  ingestionActionPath,
  ingestionActionScopeHeader,
  ingestionSnapshotPath,
  type IngestionQueueActionResultDto,
  type IngestionSessionPairDto
} from "@imageshow/shared/browser";
import { runIntegrationScenario } from "./integration-runtime.mts";
import { activeSession, createIngestionScenarioFixture } from "./ingestion-scenario-fixture.mts";

await runIntegrationScenario(async (runtime) => {
  const fixture = await createIngestionScenarioFixture(runtime);
  const { createHttpApp } = await import("../../../../packages/server/src/http-app.ts");
  const { openIngestionActionScope } =
    await import("../../../../packages/server/src/images/ingestion/queue/action-scope.ts");
  const { createIngestionSessionId } =
    await import("../../../../packages/server/src/images/ingestion/sessions/identity.ts");
  const { ingestionSessionSemanticHash } =
    await import("../../../../packages/server/src/images/ingestion/sessions/projection.ts");
  const { randomUuidV7 } = await import("../../../../packages/server/src/core/uuid.ts");
  const config = structuredClone(runtime.runtimeConfigStore.getRuntimeConfig());
  config.altcha.enabled = false;
  await runtime.runtimeConfigStore.replaceRuntimeConfig(config);
  const app = createHttpApp({
    businessGateIsOpen: () => true,
    requireRedis: () => runtime.redisClient.redis.ping()
  });
  const server = createServer(getRequestListener(app.fetch));
  const address = await listenForFetch(server);
  const origin = `http://127.0.0.1:${address.port}`;
  let scope: ReturnType<typeof openIngestionActionScope> | undefined;
  try {
    const login = await fetch(origin + "/api/admin/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ username: "integration-admin", password: "IntegrationAdmin123!" })
    });
    assert.equal(login.status, 200, await login.clone().text());
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const { csrf_token } = (await login.json()) as { csrf_token: string };
    scope = openIngestionActionScope(
      { id: cookie.slice(cookie.indexOf("=") + 1), username: "integration-admin" },
      "import",
      () => {}
    );
    const headers = {
      "content-type": "application/json",
      origin,
      cookie,
      "x-csrf-token": csrf_token,
      [ingestionActionScopeHeader]: scope.id
    };
    const pairs: IngestionSessionPairDto[] = [];
    for (let index = 0; index <= 3600; index++) {
      const sessionId = createIngestionSessionId("integration-admin", "import", String(index));
      const template = {
        ...fixture.importTemplate,
        owner: "integration-admin",
        session_id: sessionId,
        image_id: randomUuidV7(),
        image_time: new Date().toISOString()
      };
      const now = Date.now();
      const session = activeSession(
        (
          await fixture.productionIngestionRepository.acceptImportSession(
            {
              ...template,
              semantic_hash: ingestionSessionSemanticHash(template)
            },
            fixture.displayOrderKey(sessionId, index, now),
            now
          )
        ).session
      );
      pairs.push({ session_id: session.session_id, image_id: session.image_id });
    }
    const actionSizes: number[] = [];
    for (const chunked of [false, true]) {
      const snapshot = await fetch(origin + ingestionSnapshotPath + "?queue=import&limit=1", {
        method: "POST",
        headers,
        body: JSON.stringify({ exclude_items: [], include_items: [] })
      });
      assert.equal(snapshot.status, 200, await snapshot.clone().text());
      const { action_watermark } = (await snapshot.json()) as { action_watermark: string };
      const title = chunked ? "chunked action" : "known length action";
      const body = Buffer.from(
        JSON.stringify({
          queue: "import",
          action: "apply_metadata",
          action_request_id: randomUuidV7(),
          action_watermark,
          items: pairs.slice(0, 3600),
          metadata: { title }
        })
      );
      actionSizes.push(body.length);
      assert.ok(body.length > 128 * 1024);
      let offset = 0;
      const init: RequestInit & { duplex?: "half" } = chunked
        ? {
            body: new ReadableStream<Uint8Array>({
              pull(controller) {
                if (offset === body.length) return controller.close();
                const end = Math.min(offset + 16384, body.length);
                controller.enqueue(body.subarray(offset, end));
                offset = end;
              }
            }),
            duplex: "half"
          }
        : { body };
      const result = await fetch(origin + ingestionActionPath, {
        method: "POST",
        headers,
        ...init
      });
      assert.equal(result.status, 200, await result.clone().text());
      const receipt = (await result.json()) as IngestionQueueActionResultDto;
      assert.equal(receipt.processed, 3600);
      assert.equal(receipt.changed, 3600);
      assert.equal(receipt.failed, 0);
      const stored = await fixture.productionIngestionRepository.readSessions(
        "integration-admin",
        pairs
      );
      for (const session of stored.slice(0, 3600)) {
        assert.ok(session && typeof session === "object");
        assert.equal(activeSession(session).metadata.title, title);
      }
      const outside = stored[3600];
      assert.ok(outside && typeof outside === "object");
      assert.equal(
        activeSession(outside).metadata.title,
        fixture.importTemplate.metadata.title,
        "精确集合之外的任务不受批量属性修改影响"
      );
    }

    // Stream probes use the complete HTTP app, without allocating a 160 MiB
    // fixture. Zero prefetch makes auth-before-body ordering observable.
    const probe = async (
      path: string,
      expected: number,
      authenticated: boolean,
      csrf: string,
      declared: boolean
    ) => {
      let reads = 0;
      const chunk = new Uint8Array(1024 * 1024);
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (reads === 161) return controller.close();
            reads++;
            controller.enqueue(chunk);
          }
        },
        { highWaterMark: 0 }
      );
      const request = new Request(origin + path, {
        method: "POST",
        headers: {
          ...headers,
          host: new URL(origin).host,
          cookie: authenticated ? cookie : "",
          "x-csrf-token": csrf,
          ...(declared ? { "content-length": String(161 * 1024 * 1024) } : {})
        },
        body,
        duplex: "half"
      } as RequestInit & { duplex: "half" });
      try {
        const response = await app.request(request);
        assert.equal(response.status, expected, await response.clone().text());
        if (expected === 413)
          assert.equal(
            ((await response.json()) as { code: string }).code,
            "request_body_too_large"
          );
        if (expected === 401 || expected === 403 || declared) assert.equal(reads, 0);
        return reads;
      } finally {
        await request.body?.cancel();
      }
    };
    await probe(ingestionActionPath, 401, false, "", false);
    await probe(ingestionActionPath, 403, true, "wrong-csrf", false);
    await probe(ingestionActionPath, 413, true, csrf_token, true);
    assert.equal(await probe(ingestionActionPath, 413, true, csrf_token, false), 161);
    assert.equal(await probe(ingestionSnapshotPath, 413, true, csrf_token, false), 2);
    assert.equal(await probe("/api/admin/ordinary-body", 413, true, csrf_token, false), 1);
    console.log(
      JSON.stringify({
        scenario: "ingestion-http-boundaries",
        preciseItems: 3600,
        actionSizes,
        transports: ["content-length", "chunked"],
        authBeforeRead: true,
        bounded: true
      })
    );
  } finally {
    scope?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
