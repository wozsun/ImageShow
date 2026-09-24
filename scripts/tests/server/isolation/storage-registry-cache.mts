import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { appConfig } from "@imageshow/shared";
import { runIntegrationScenario } from "./integration-runtime.mts";
import { interceptPoolConnections, interceptSqlQueries } from "./database-faults.mts";

await runIntegrationScenario(async ({ databasePools: { pool }, storageRegistry: registry }) => {
  const { withPublicDatabaseRead } =
    await import("../../../../packages/server/src/core/database/public-fallback.ts");
  const { getPublicPgFallbackAdmissionSnapshot } =
    await import("../../../../packages/server/src/core/database/public-admission.ts");
  let reads = 0;
  let capture:
    | {
        reached: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  let failNext = false;
  const intercepted = new WeakSet();
  const restore = interceptPoolConnections(pool, (client) => {
    if (intercepted.has(client)) return;
    intercepted.add(client);
    return interceptSqlQueries(client, async (sql, _values, run) => {
      if (!sql.includes("FROM storage_backend")) return run();
      reads += 1;
      if (failNext) {
        failNext = false;
        throw new Error("controlled registry failure");
      }
      const gate = capture;
      capture = undefined;
      const result = await run();
      gate?.reached.resolve();
      await gate?.release.promise;
      return result;
    });
  });
  const signal = () => AbortSignal.timeout(15_000);
  const read = (requestSignal = signal()) =>
    registry.listStorageBackends({ signal: requestSignal });
  const idle = () =>
    assert.deepEqual(getPublicPgFallbackAdmissionSnapshot(), { active: 0, queued: 0 });
  const holdResult = () => {
    const gate = { reached: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    capture = gate;
    return gate;
  };
  try {
    // Real image SQL scopes finish before all callers wait for the shared registry.
    registry.invalidateStorageBackendRegistry();
    const cold = await Promise.all(
      Array.from({ length: 128 }, async () => {
        const requestSignal = signal();
        await withPublicDatabaseRead(requestSignal, ({ reader }) => reader.query("SELECT 1"));
        return read(requestSignal);
      })
    );
    assert.equal(reads, 1);
    cold.forEach((rows) => assert.equal(rows[0]?.slug, "local"));
    await Promise.all(Array.from({ length: 128 }, () => read()));
    assert.equal(reads, 1, "warm registry performs no further query");
    idle();

    for (const mode of ["cancel-one", "timeout-one", "cancel-all"] as const) {
      registry.invalidateStorageBackendRegistry();
      const blocker = await pool.connect();
      const started = Promise.withResolvers<void>();
      const restoreNotice = interceptPoolConnections(pool, (client) =>
        interceptSqlQueries(client, (sql, _values, run) => {
          if (sql.includes("FROM storage_backend")) started.resolve();
          return run();
        })
      );
      const controller = new AbortController();
      try {
        await blocker.query("BEGIN; LOCK TABLE storage_backend IN ACCESS EXCLUSIVE MODE");
        const before: number = reads;
        const rejected = assert.rejects(
          read(mode === "timeout-one" ? AbortSignal.timeout(25) : controller.signal)
        );
        const survivor = mode === "cancel-all" ? undefined : read();
        await started.promise;
        controller.abort();
        await rejected;
        await blocker.query("ROLLBACK");
        if (survivor) await survivor;
        for (
          let attempts = 0;
          getPublicPgFallbackAdmissionSnapshot().active && attempts < 100;
          attempts++
        )
          await nextTurn();
        idle();
        assert.equal(reads - before, 1);
        if (mode === "cancel-all") {
          await read();
          assert.equal(reads - before, 2, "all callers leaving allows a new load");
        }
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        restoreNotice();
      }
    }

    registry.invalidateStorageBackendRegistry();
    const stale = holdResult();
    const previous = read();
    try {
      await stale.reached.promise;
      await pool.query("UPDATE storage_backend SET display_name='Current' WHERE slug='local'");
      registry.invalidateStorageBackendRegistry();
      const before = reads;
      const current = await Promise.all(Array.from({ length: 32 }, () => read()));
      assert.equal(reads - before, 1);
      current.forEach((rows) => assert.equal(rows[0]?.display_name, "Current"));
    } finally {
      stale.release.resolve();
    }
    assert.equal(
      (await previous)[0]?.display_name,
      "Current",
      "late snapshot cannot overwrite invalidation"
    );

    registry.invalidateStorageBackendRegistry();
    failNext = true;
    const beforeFailure = reads;
    const failed = await Promise.allSettled(Array.from({ length: 32 }, () => read()));
    assert.ok(failed.every((result) => result.status === "rejected"));
    assert.equal(reads - beforeFailure, 1);
    await read();
    assert.equal(reads - beforeFailure, 2);

    const realNow = Date.now;
    let now = realNow();
    try {
      Date.now = () => now;
      registry.invalidateStorageBackendRegistry();
      await read();
      await pool.query("UPDATE storage_backend SET display_name='After expiry' WHERE slug='local'");
      const beforeExpiry = reads;
      now += appConfig.storageRegistry.ttlSeconds * 1000 - 1;
      assert.equal((await read())[0]?.display_name, "Current");
      assert.equal(reads, beforeExpiry);
      now += 1;
      const expired = await Promise.all(Array.from({ length: 64 }, () => read()));
      assert.equal(reads - beforeExpiry, 1);
      expired.forEach((rows) => assert.equal(rows[0]?.display_name, "After expiry"));
    } finally {
      Date.now = realNow;
      registry.invalidateStorageBackendRegistry();
    }

    await pool.query(
      "INSERT INTO storage_backend(slug,display_name,type) SELECT 'limit-'||n,'Limit','local' FROM generate_series(1,$1::int) n",
      [appConfig.publicPgFallback.maximumStorageBackendRows]
    );
    await assert.rejects(read(), { code: "public_pg_fallback_work_limit" });
    assert.equal(
      (await registry.listStorageBackends()).length,
      appConfig.publicPgFallback.maximumStorageBackendRows + 1
    );
    await assert.rejects(read(), { code: "public_pg_fallback_work_limit" });
    await pool.query("DELETE FROM storage_backend WHERE slug LIKE 'limit-%'");
    registry.invalidateStorageBackendRegistry();

    const closing = holdResult();
    const rejected = assert.rejects(read(), { code: "storage_registry_closed" });
    try {
      await closing.reached.promise;
      await registry.closeStorageBackendRegistry();
    } finally {
      closing.release.resolve();
    }
    await rejected;
    await assert.rejects(read(), { code: "storage_registry_closed" });
    idle();
  } finally {
    capture?.release.resolve();
    restore();
  }
});
