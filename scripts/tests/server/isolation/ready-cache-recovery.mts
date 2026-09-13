import assert from "node:assert/strict";
import { connect, createServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { runIntegrationScenario } from "./integration-runtime.mts";

// Only this scenario's application connection passes through the relay. Closing
// it reproduces connection refusal without stopping any database service.
const databaseHost = process.argv[2]!;
const databasePort = Number(process.argv[3]);
const sockets = new Set<Socket>();
const relay = createServer((downstream) => {
  const upstream = connect(databasePort, databaseHost);
  for (const socket of [downstream, upstream]) {
    sockets.add(socket);
    socket.on("error", () => { downstream.destroy(); upstream.destroy(); });
    socket.on("close", () => sockets.delete(socket));
  }
  upstream.pipe(downstream).pipe(upstream);
});
const listen = (port: number) => new Promise<void>((resolve, reject) => {
  relay.once("error", reject);
  relay.listen(port, "127.0.0.1", () => { relay.off("error", reject); resolve(); });
});
const close = async () => {
  for (const socket of sockets) socket.destroy();
  if (relay.listening) await new Promise<void>((resolve, reject) => relay.close((error) => error ? reject(error) : resolve()));
};
await listen(0);
const address = relay.address();
assert.ok(address && typeof address !== "string");
process.argv[2] = "127.0.0.1";
process.argv[3] = String(address.port);

try {
  await runIntegrationScenario(async (runtime) => {
    const { pool } = runtime.databasePools;
    const { ReadyImageCacheCoordinator } = await import("../../../../packages/server/src/images/ready-cache/coordinator-machine.ts");
    const { probeRedisOperationalState, getRedisOperationalState } = await import("../../../../packages/server/src/core/runtime-availability.ts");
    const { rebuildReadyImageCache } = await import("../../../../packages/server/src/images/ready-cache/rebuild.ts");
    const { readReadyImageCacheMeta } = await import("../../../../packages/server/src/images/ready-cache/meta.ts");
    const { randomUuidV7 } = await import("../../../../packages/server/src/core/uuid.ts");
    const { storageObjectKey } = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
    const coordinator = new ReadyImageCacheCoordinator();
    const imageId = randomUuidV7();
    await pool.query("INSERT INTO metadata(id, created_by, status, storage_slug, object_key, device, brightness, ext, md5, image_time, title) "
      + "VALUES($1, 'integration-admin', 'ready', 'local', $2, 'pc', 'dark', 'webp', $3, now(), 'Preserved image')",
    [imageId, storageObjectKey(imageId, "webp"), "a".repeat(32)]);
    await probeRedisOperationalState();
    const originalMeta = await rebuildReadyImageCache();
    assert.equal(originalMeta.itemCount, 1);
    let scheduleAttempts = 0;
    const query = pool.query;
    pool.query = ((...args: never[]) => {
      if (/INSERT INTO background_job/.test(String(args[0]))) scheduleAttempts += 1;
      return Reflect.apply(query, pool, args);
    }) as typeof pool.query;
    try {
      const redisBefore = getRedisOperationalState();
      await close();
      await delay(0);
      assert.equal((await coordinator.initialize()).readable, false);
      assert.equal(scheduleAttempts, 1, "durable recovery also reached the unavailable connection");
      assert.deepEqual(await readReadyImageCacheMeta(), originalMeta, "valid Redis core survives database outage");
      await listen(address.port);
      const restoredAt = performance.now();
      while (!coordinator.readyImageCacheIsReadable() && performance.now() - restoredAt < 15_000) {
        await delay(25);
      }
      process.stdout.write(JSON.stringify({ recovery_ms: Math.round(performance.now() - restoredAt),
        status: coordinator.getStatus(), schedule_attempts: scheduleAttempts }) + "\n");
      assert.equal(coordinator.readyImageCacheIsReadable(), true);
      assert.deepEqual(getRedisOperationalState(), redisBefore, "recovery does not require a new Redis event");
      assert.deepEqual(await readReadyImageCacheMeta(), originalMeta, "healthy cache is validated without a full rebuild");
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM background_job WHERE type='cache.rebuild'")).rows[0].count, 0);
      assert.equal((await pool.query("SELECT title FROM metadata WHERE id=$1", [imageId])).rows[0].title, "Preserved image");
      assert.deepEqual(await coordinator.withRead(async () => "cached"), { acquired: true, value: "cached" });
    } finally {
      await coordinator.stop();
      pool.query = query;
    }
  });
} finally {
  await close();
}
