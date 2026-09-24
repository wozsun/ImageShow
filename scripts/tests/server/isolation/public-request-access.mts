import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mock } from "node:test";
import { storageObjectKey } from "@imageshow/shared/browser";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
  const { createHttpApp } = await import("../../../../packages/server/src/http-app.ts");
  const { LocalBackend } = await import("../../../../packages/server/src/storage/drivers/local.ts");
  const { updateStorageBackend } =
    await import("../../../../packages/server/src/storage/backends/update.ts");
  const { reloadRuntimeConfigFromDisk } =
    await import("../../../../packages/server/src/config/runtime-config-store.ts");
  const { redis } = runtime.redisClient;
  const { updateRuntimeConfig, getRuntimeConfig } = runtime.runtimeConfigStore;
  await updateRuntimeConfig({
    site: { domain: "images.example.test" },
    embed: {
      enabled: false,
      allowed_origins: ["https://portal.example.test", "https://*.trusted.example.test"]
    },
    security: { random_window_seconds: 60, random_max_requests: 3, random_limit_max_requests: 2 }
  });
  const app = createHttpApp({
    businessGateIsOpen: () => true,
    requireRedis: async () => undefined
  });
  const id = "00000000-0000-7000-8000-0000000000c1";
  const key = storageObjectKey(id, "webp");
  const bytes = Buffer.from("synthetic image bytes for access contracts");
  const local = new LocalBackend();
  await runtime.databasePools.pool.query(
    "INSERT INTO metadata(id,created_by,status,storage_slug,device,brightness,ext,md5) VALUES($1,'integration-admin','ready','local','pc','dark','webp',$2)",
    [id, "1".repeat(32)]
  );
  await local.writeBuffer("full", key, bytes, "image/webp");
  await local.writeBuffer("thumbs", key, bytes, "image/webp");
  const request = (
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
    host = "images.example.test"
  ) =>
    app.request(`http://internal.test${path}`, {
      method,
      headers: { Host: host, "X-Forwarded-Proto": "https", "X-Real-IP": "192.0.2.1", ...headers }
    });
  const random = (query = "mode=json") => `/random?id=${id}&${query}`;
  const expectStatus = async (response: Response, status: number) => {
    assert.equal(response.status, status, await response.clone().text());
    await response.arrayBuffer();
  };
  const expectLimited = async (response: Response) => {
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(response.headers.get("Retry-After")!, /^[1-9]\d*$/);
    assert.ok(
      Number(response.headers.get("Retry-After")) <=
        getRuntimeConfig().security.random_window_seconds
    );
    assert.equal((await response.json()).code, "random_rate_limited");
  };

  await expectStatus(await request(random("mode=proxy")), 200);
  await expectStatus(await request(random("mode=redirect"), {}, "HEAD"), 302);
  await expectStatus(await request(random()), 200);
  await expectLimited(await request(random()));
  await expectStatus(await request(random("mode=json&limit=1")), 200);
  await expectStatus(await request(random("mode=json&limit=2"), {}, "HEAD"), 200);
  await expectLimited(await request(random("mode=json&limit=1")));
  await expectStatus(await request(random(), { "X-Real-IP": "192.0.2.2" }), 200);

  for (const referer of [
    "https://images.example.test/gallery",
    "https://sub.images.example.test/",
    "https://portal.example.test/article?q=1",
    "https://a.b.trusted.example.test/"
  ]) {
    for (const query of ["mode=json", "mode=json&limit=1"]) {
      await expectStatus(await request(random(query), { Referer: referer }), 200);
    }
  }
  await expectLimited(await request(random(), { Referer: "https://untrusted.example.test/" }));
  await expectLimited(await request(random("mode=json&limit=1"), { Referer: "not-a-url" }));

  const failures = { "X-Real-IP": "192.0.2.3" };
  await expectStatus(await request(random("mode=invalid"), failures), 400);
  await expectStatus(await request(random("mode=json&limit="), failures), 400);
  await expectStatus(await request(random("mode=json&limit=1&limit=1"), failures), 400);
  await expectLimited(await request(random("mode=json&limit=1"), failures));
  await expectStatus(await request(random(), failures), 200);
  await expectStatus(await request(random(), failures), 200);
  await expectLimited(await request(random(), failures));

  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () => request(random(), { "X-Real-IP": "192.0.2.4" }))
  );
  assert.equal(concurrent.filter((response) => response.status === 200).length, 3);
  assert.equal(concurrent.filter((response) => response.status === 429).length, 5);
  for (const response of concurrent) await response.arrayBuffer();
  await expectStatus(await request(random(), { "X-Real-IP": "192.0.2.5" }, "POST"), 405);
  for (let index = 0; index < 3; index++)
    await expectStatus(await request(random(), { "X-Real-IP": "192.0.2.5" }), 200);
  await expectLimited(await request(random(), { "X-Real-IP": "192.0.2.5" }));

  await updateRuntimeConfig({ security: { random_window_seconds: 2, random_max_requests: 1 } });
  const expiring = { "X-Real-IP": "192.0.2.6" };
  await expectStatus(await request(random(), expiring), 200);
  await delay(1100);
  await expectLimited(await request(random(), expiring));
  await delay(1100);
  await expectStatus(await request(random(), expiring), 200);
  await updateRuntimeConfig({ security: { random_window_seconds: 60, random_max_requests: 3 } });

  // White-list changes apply to the next request, including after disk reload.
  await updateRuntimeConfig({ embed: { allowed_origins: ["https://replacement.example.test"] } });
  await reloadRuntimeConfigFromDisk();
  await expectLimited(await request(random(), { Referer: "https://portal.example.test/" }));
  await expectStatus(
    await request(random(), { Referer: "https://replacement.example.test/page" }),
    200
  );
  await updateRuntimeConfig({
    embed: { allowed_origins: ["https://portal.example.test", "https://*.trusted.example.test"] }
  });

  const openRead = mock.method(LocalBackend.prototype, "openRead");
  try {
    for (const prefix of ["full", "thumbs"]) {
      const path = `/images/${prefix}/${key}`;
      const readable = await request(path, { Referer: "https://portal.example.test/article?q=1" });
      assert.equal(readable.status, 200);
      assert.equal(readable.headers.get("Vary"), "Referer");
      assert.deepEqual(Buffer.from(await readable.arrayBuffer()), bytes);
      const etag = readable.headers.get("ETag")!;
      for (const [method, headers, expected] of [
        ["GET", {}, 200],
        ["HEAD", {}, 200],
        ["GET", { "If-None-Match": etag }, 304],
        ["GET", { Range: "bytes=0-2", "If-Range": etag }, 206],
        ["GET", { Range: "bytes=9999-" }, 416]
      ] as const) {
        const response = await request(path, headers as Record<string, string>, method);
        assert.equal(response.status, expected);
        assert.equal(response.headers.get("Vary"), "Referer");
        const body = Buffer.from(await response.arrayBuffer());
        if (method === "HEAD" || expected === 304) assert.equal(body.length, 0);
        if (expected === 206) assert.deepEqual(body, bytes.subarray(0, 3));
        const beforeDenied = openRead.mock.callCount();
        const denied = await request(
          path,
          { ...headers, Referer: "https://attacker.example.test/" },
          method
        );
        assert.equal(denied.status, 403);
        assert.equal(denied.headers.get("Cache-Control"), "no-store");
        assert.equal(denied.headers.get("Vary"), "Referer");
        if (method === "GET") assert.equal((await denied.json()).code, "image_referer_forbidden");
        else assert.equal(await denied.text(), "");
        assert.equal(
          openRead.mock.callCount(),
          beforeDenied,
          "rejected requests never open image objects"
        );
      }
    }
    await expectStatus(
      await request(`/images/original/${id}`, { Referer: "https://portal.example.test/" }),
      401
    );
    await updateStorageBackend("local", { public_base_url: "https://media.example.test/pictures" });
    const redirected = await request(`/images/full/${key}`, {
      Referer: "https://images.example.test/"
    });
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get("Vary"), "Referer");
    assert.equal(
      redirected.headers.get("Location"),
      `https://media.example.test/pictures/full/${key}`
    );
    await redirected.arrayBuffer();
    for (const prefix of ["full", "thumbs"]) {
      const path = `/pictures/${prefix}/${key}`;
      for (const referer of [
        "",
        "https://portal.example.test/path",
        "https://child.images.example.test/"
      ]) {
        const response = await request(path, { Referer: referer }, "GET", "media.example.test");
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("Vary"), "Referer");
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      }
      const beforeDenied = openRead.mock.callCount();
      await expectStatus(
        await request(
          path,
          { Referer: "https://attacker.example.test/", Range: "bytes=0-2" },
          "GET",
          "media.example.test"
        ),
        403
      );
      await expectStatus(
        await request(
          path,
          { Referer: "https://attacker.example.test/" },
          "HEAD",
          "media.example.test"
        ),
        403
      );
      assert.equal(openRead.mock.callCount(), beforeDenied);
      await expectStatus(
        await request(
          path,
          { Origin: "https://portal.example.test", "Access-Control-Request-Method": "GET" },
          "OPTIONS",
          "media.example.test"
        ),
        204
      );
    }
  } finally {
    openRead.mock.restore();
  }

  const ended = once(redis, "end");
  redis.disconnect();
  await ended;
  const unavailable = await request(random(), { "X-Real-IP": "192.0.2.7" });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("Cache-Control"), "no-store");
  assert.equal((await unavailable.json()).code, "redis_unavailable");
  await expectStatus(await request(random(), { Referer: "https://portal.example.test/" }), 200);
});
