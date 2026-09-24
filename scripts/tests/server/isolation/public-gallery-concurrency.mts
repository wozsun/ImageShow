import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { getRequestListener } from "@hono/node-server";
import { listenForFetch } from "../../support/http-listen.ts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
  const { pool } = runtime.databasePools;
  const { createHttpApp } = await import("../../../../packages/server/src/http-app.ts");
  const { getPublicPgFallbackAdmissionSnapshot } =
    await import("../../../../packages/server/src/core/database/public-admission.ts");
  await pool.query("INSERT INTO tag(slug, display_name) VALUES('shared-tag', 'Shared tag')");
  for (const endpoint of ["gallery-facets", "gallery-stats"]) {
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE metadata IN ACCESS EXCLUSIVE MODE");
    let checkouts = 0;
    const originalConnect = pool.connect;
    pool.connect = ((...args: never[]) => {
      checkouts += 1;
      return Reflect.apply(originalConnect, pool, args);
    }) as typeof pool.connect;
    const app = createHttpApp({
      businessGateIsOpen: () => true,
      requireRedis: () => runtime.redisClient.redis.ping()
    });
    const listener = getRequestListener(app.fetch);
    let arrived = 0;
    const allArrived = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      if (++arrived === 200) allArrived.resolve();
      listener(request, response);
    });
    const address = await listenForFetch(server);
    const signals = Array.from({ length: 200 }, () => AbortSignal.timeout(15_000));
    const responses = Promise.all(
      signals.map((signal) =>
        fetch(`http://127.0.0.1:${address.port}/api/${endpoint}`, { signal }).then(
          async (response) => ({
            status: response.status,
            value: await response.json()
          })
        )
      )
    );
    void responses.catch(() => undefined);
    try {
      await Promise.race([
        allArrived.promise,
        responses.then(() => {
          throw new Error("Requests completed before all arrivals");
        })
      ]);
      await nextTurn();
      await blocker.query("ROLLBACK");
      const result = await responses;
      process.stdout.write(
        JSON.stringify({
          endpoint,
          requests: result.length,
          checkouts,
          succeeded: result.filter((entry) => entry.status === 200).length,
          admission: getPublicPgFallbackAdmissionSnapshot()
        }) + "\n"
      );
      assert.ok(
        result.every((entry) => entry.status === 200),
        JSON.stringify(result.filter((entry) => entry.status !== 200))
      );
      assert.equal(checkouts, 1, "identical requests share one bounded PostgreSQL scope");
      assert.deepEqual(
        (result[0]!.value as { tags: unknown }).tags,
        endpoint === "gallery-stats" ? [] : [{ slug: "shared-tag", display_name: "Shared tag" }]
      );
      for (const entry of result) assert.deepEqual(entry.value, result[0]!.value);
      assert.deepEqual(getPublicPgFallbackAdmissionSnapshot(), { active: 0, queued: 0 });
      const subsequent = await fetch(`http://127.0.0.1:${address.port}/api/${endpoint}`);
      assert.equal(subsequent.status, 200);
      await subsequent.json();
      assert.equal(checkouts, 2, "completed responses are not retained as an extra cache");
      if (endpoint === "gallery-stats") {
        const { getPublicGalleryStats } =
          await import("../../../../packages/server/src/images/read-models/gallery-stats.ts");
        await blocker.query("BEGIN");
        await blocker.query("LOCK TABLE metadata IN ACCESS EXCLUSIVE MODE");
        const cancelled = new AbortController();
        const first = getPublicGalleryStats({}, cancelled.signal);
        const cancelledResult = assert.rejects(first, { name: "AbortError" });
        const survivor = getPublicGalleryStats({}, AbortSignal.timeout(15_000));
        cancelled.abort();
        await cancelledResult;
        await blocker.query("ROLLBACK");
        assert.deepEqual({ ok: true, ...(await survivor) }, result[0]!.value);
        assert.equal(
          checkouts,
          3,
          "one cancelled visitor leaves the shared database read available to others"
        );
        assert.deepEqual(getPublicPgFallbackAdmissionSnapshot(), { active: 0, queued: 0 });
        await pool.query(
          `INSERT INTO metadata(id, created_by, status, storage_slug, device, brightness, ext, md5)
       VALUES ('00000000-0000-7000-8000-0000000000aa', 'integration-admin', 'ready', 'local', 'pc', 'dark', 'webp', $1)`,
          ["a".repeat(32)]
        );
        const beforeFilteredReads = checkouts;
        const [desktop, mobile] = await Promise.all([
          getPublicGalleryStats({ device: "pc" }, AbortSignal.timeout(15_000)),
          getPublicGalleryStats({ device: "mb" }, AbortSignal.timeout(15_000))
        ]);
        assert.equal(desktop.matching_images, 1);
        assert.equal(mobile.matching_images, 0);
        assert.equal(checkouts - beforeFilteredReads, 2, "different filters own separate reads");
        assert.deepEqual(getPublicPgFallbackAdmissionSnapshot(), { active: 0, queued: 0 });
      }
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await responses.catch(() => undefined);
      pool.connect = originalConnect;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
