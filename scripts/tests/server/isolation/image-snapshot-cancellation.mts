import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { getRequestListener } from "@hono/node-server";
import { listenForFetch } from "../../support/http-listen.ts";
import { interceptSqlQueries } from "./database-faults.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";
import { createMaintenanceFixture, settleWithin } from "./storage-maintenance-fixture.mts";

await runIntegrationScenario(async (runtime) => {
  const fixture = await createMaintenanceFixture(runtime);
  const image = await fixture.createImage();
  const { createHttpApp } = await import("../../../../packages/server/src/http-app.ts");
  const { getAdminImageSnapshots } =
    await import("../../../../packages/server/src/images/read-models/admin-images.ts");
  const { withPublicDatabaseRead } =
    await import("../../../../packages/server/src/core/database/public-fallback.ts");
  const { imageUpdateLockRequests } =
    await import("../../../../packages/server/src/images/image-update-lock.ts");
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
  const writer = await runtime.databasePools.pool.connect();
  const lockKey = imageUpdateLockRequests([image.id])[0]!.key;
  let locked = false;
  let snapshotSelects = 0;
  const restoreQuery = interceptSqlQueries(runtime.databasePools.pool, (sql, _values, query) => {
    if (sql.includes("WHERE id = ANY($1::uuid[])") && sql.includes("AND status = 'ready'"))
      snapshotSelects++;
    return query();
  });
  const waiting = async () =>
    Number(
      (
        await runtime.databasePools.pool.query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() " +
            "AND application_name='imageshow-advisory-locks' AND wait_event_type='Lock'"
        )
      ).rows[0].count
    );
  const waitForCount = async (count: number, inspect = waiting) => {
    const expires = Date.now() + 4_000;
    while (Date.now() < expires) {
      if ((await inspect()) === count) return;
      await delay(10);
    }
    assert.equal(await inspect(), count, "取消的数据库工作应随消费者生命周期结束");
  };
  try {
    const login = await fetch(origin + "/api/admin/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ username: "integration-admin", password: "IntegrationAdmin123!" })
    });
    assert.equal(login.status, 200, await login.clone().text());
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const auth = await fetch(origin + "/api/admin/auth/me", { headers: { cookie } });
    const { csrf_token: csrf } = (await auth.json()) as { csrf_token: string };
    const headers = { "content-type": "application/json", origin, cookie, "x-csrf-token": csrf };
    await writer.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
    locked = true;
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const abandoned = controllers.map((controller) =>
      fetch(origin + "/api/admin/images/snapshot", {
        method: "POST",
        headers,
        body: JSON.stringify({ ids: [image.id] }),
        signal: controller.signal
      }).then((response) => response.text())
    );
    const outcomes = Promise.allSettled(abandoned);
    await waitForCount(4);
    for (const controller of controllers) controller.abort();
    assert.ok((await outcomes).every((outcome) => outcome.status === "rejected"));
    await waitForCount(0);
    assert.equal(snapshotSelects, 0, "断开的快照消费者不能在之后执行读取");

    const preAborted = new AbortController();
    preAborted.abort(new Error("cancel before checkout"));
    await assert.rejects(
      getAdminImageSnapshots([image.id], preAborted.signal),
      /cancel before checkout/
    );
    assert.equal(snapshotSelects, 0);

    const live = fetch(origin + "/api/admin/images/snapshot", {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: [image.id] })
    });
    await waitForCount(1);
    await writer.query("UPDATE metadata SET title='authoritative-after-lock' WHERE id=$1", [
      image.id
    ]);
    await writer.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
    locked = false;
    const response = await settleWithin(live);
    assert.equal(response.status, 200, await response.clone().text());
    const snapshot = (await response.json()) as { items: Array<{ title: string }> };
    assert.equal(snapshot.items[0]?.title, "authoritative-after-lock");
    assert.equal(snapshotSelects, 1);

    // A destroyed regular-pool client must also stop server-side work, rather
    // than merely giving up its local admission lease while SQL keeps running.
    const readAbort = new AbortController();
    const readReason = new Error("cancel public SQL");
    const read = withPublicDatabaseRead(readAbort.signal, ({ reader }) =>
      reader.query("SELECT pg_sleep(30) /* cancelled-public-read */")
    );
    const readRejected = assert.rejects(read, (error) => error === readReason);
    const runningRead = async () =>
      Number(
        (
          await runtime.databasePools.pool.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() " +
              "AND state='active' AND query=$1",
            ["SELECT pg_sleep(30) /* cancelled-public-read */"]
          )
        ).rows[0].count
      );
    await waitForCount(1, runningRead);
    readAbort.abort(readReason);
    await readRejected;
    await waitForCount(0, runningRead);

    // Exercise the real HTTP schema used by lost-receipt text confirmation.
    const update = await fetch(origin + "/api/admin/images/update", {
      method: "POST",
      headers,
      body: JSON.stringify({
        items: [
          {
            id: image.id,
            title: "  normalized title  ",
            description: "\n  first\n second  \n",
            source: " example.com/post ",
            original: " https://example.com/image.jpg "
          }
        ]
      })
    });
    assert.equal(update.status, 200, await update.clone().text());
    const normalized = await getAdminImageSnapshots([image.id]);
    assert.deepEqual(
      Object.fromEntries(
        ["title", "description", "source", "original"].map((field) => [
          field,
          normalized.items[0]![field as "title" | "description" | "source" | "original"]
        ])
      ),
      {
        title: "normalized title",
        description: "first\n second",
        source: "https://example.com/post",
        original: "https://example.com/image.jpg"
      }
    );
    console.log(
      JSON.stringify({
        scenario: "image-snapshot-cancellation",
        cancelled: 4,
        waitingAfterAbort: 0,
        abandonedReads: 0,
        cancelledPublicQueries: 1,
        liveSnapshot: snapshot.items[0]?.title,
        normalized: true
      })
    );
  } finally {
    if (locked) await writer.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
    writer.release();
    restoreQuery();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
