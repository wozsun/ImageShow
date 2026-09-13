import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { getRequestListener } from "@hono/node-server";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
  const { pool } = runtime.databasePools;
  const { createHttpApp } = await import("../../../../packages/server/src/http-app.ts");
  const { getPublicPgFallbackAdmissionSnapshot } = await import("../../../../packages/server/src/core/database/public-admission.ts");
  await pool.query("INSERT INTO tag(slug, display_name) VALUES('shared-tag', 'Shared tag')");
  const blocker = await pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("LOCK TABLE metadata IN ACCESS EXCLUSIVE MODE");
  let checkouts = 0;
  const originalConnect = pool.connect;
  pool.connect = ((...args: never[]) => {
    checkouts += 1;
    return Reflect.apply(originalConnect, pool, args);
  }) as typeof pool.connect;
  const app = createHttpApp({ businessGateIsOpen: () => true, requireRedis: () => runtime.redisClient.redis.ping() });
  const listener = getRequestListener(app.fetch);
  let arrived = 0;
  const allArrived = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    if (++arrived === 200) allArrived.resolve();
    listener(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const signals = Array.from({ length: 200 }, () => AbortSignal.timeout(15_000));
  const responses = Promise.all(signals.map((signal) => (
    fetch(`http://127.0.0.1:${address.port}/api/gallery-facets`, { signal }).then(async (response) => ({
      status: response.status, value: await response.json()
    }))
  )));
  void responses.catch(() => undefined);
  try {
    await Promise.race([allArrived.promise, responses.then(() => { throw new Error("Requests completed before all arrivals"); })]);
    await nextTurn();
    await blocker.query("ROLLBACK");
    const result = await responses;
    process.stdout.write(JSON.stringify({ requests: result.length, checkouts,
      succeeded: result.filter((entry) => entry.status === 200).length,
      admission: getPublicPgFallbackAdmissionSnapshot() }) + "\n");
    assert.ok(result.every((entry) => entry.status === 200), JSON.stringify(result.filter((entry) => entry.status !== 200)));
    assert.equal(checkouts, 1, "identical requests share one bounded PostgreSQL scope");
    assert.deepEqual((result[0]!.value as { tags: unknown }).tags, [
      { slug: "shared-tag", display_name: "Shared tag" }
    ]);
    for (const entry of result) assert.deepEqual(entry.value, result[0]!.value);
    assert.deepEqual(getPublicPgFallbackAdmissionSnapshot(), { active: 0, queued: 0 });
    const subsequent = await fetch(`http://127.0.0.1:${address.port}/api/gallery-facets`);
    assert.equal(subsequent.status, 200);
    await subsequent.json();
    assert.equal(checkouts, 2, "completed responses are not retained as an extra cache");
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await responses.catch(() => undefined);
    pool.connect = originalConnect;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
