import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mock } from "node:test";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { storageObjectKey, type RandomImageJsonResponseDto } from "@imageshow/shared/browser";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
  const { Hono } = await import("hono");
  const { registerRandomRoutes } = await import("../../../../packages/server/src/routes/random.ts");
  const { registerPublicRoutes } = await import("../../../../packages/server/src/routes/public.ts");
  const { handleApiError } = await import("../../../../packages/server/src/core/http/responses.ts");
  const { LocalBackend } = await import("../../../../packages/server/src/storage/drivers/local.ts");
  const coordinator =
    await import("../../../../packages/server/src/images/ready-cache/coordinator.ts");
  const app = new Hono();
  app.onError((error, context) => handleApiError(context, error));
  registerRandomRoutes(app);
  registerPublicRoutes(app);
  const full = Buffer.from("synthetic JPEG original bytes");
  const thumb = Buffer.from("synthetic WebP thumbnail");
  const ids = ["00000000-0000-7000-8000-000000000011", "00000000-0000-7000-8000-000000000022"];
  const streams: Readable[] = [];
  const s3Keys: string[] = [];
  const localDriver = new LocalBackend();
  await runtime.databasePools.pool.query(
    "INSERT INTO storage_backend(slug,display_name,type,config) VALUES('synthetic-s3','Synthetic S3','s3',$1::jsonb)",
    [
      JSON.stringify({
        endpoint: "https://objects.example.com",
        region: "test-region",
        bucket: "synthetic-bucket",
        access_key_id: "synthetic-key",
        secret_access_key: "synthetic-secret",
        root_path: "gallery",
        public_base_url: "",
        force_path_style: true
      })
    ]
  );
  for (const [i, id] of ids.entries()) {
    await runtime.databasePools.pool.query(
      `INSERT INTO metadata(id,created_by,status,storage_slug,device,brightness,ext,md5,width,height,image_time)
       VALUES($1,'integration-admin','ready',$2,'pc','dark','jpg',$3,1600,900,now())`,
      [id, i === 0 ? "local" : "synthetic-s3", String(i).repeat(32)]
    );
  }
  await localDriver.writeBuffer("full", storageObjectKey(ids[0]!, "jpg"), full, "image/jpeg");
  await localDriver.writeBuffer("thumbs", storageObjectKey(ids[0]!, "webp"), thumb, "image/webp");
  const openLocal = LocalBackend.prototype.openRead;
  mock.method(
    LocalBackend.prototype,
    "openRead",
    async function (
      this: InstanceType<typeof LocalBackend>,
      ...args: Parameters<typeof openLocal>
    ) {
      const opened = await openLocal.apply(this, args);
      streams.push(opened.body);
      return opened;
    }
  );
  mock.method(S3Client.prototype, "send", async (command: unknown) => {
    assert.ok(command instanceof GetObjectCommand);
    assert.equal(command.input.Bucket, "synthetic-bucket");
    assert.equal(
      command.input.Range,
      undefined,
      "random response does not promise cross-request ranges"
    );
    const key = command.input.Key!;
    s3Keys.push(key);
    const bytes = key.includes("/thumbs/") ? thumb : full;
    const body = Readable.from([bytes]);
    streams.push(body);
    return { Body: body, ContentLength: bytes.length, ETag: '"synthetic-s3-etag"' };
  });
  const request = (query: string, method = "GET") =>
    app.request(`http://images.example/random?${query}`, {
      method,
      headers: { Referer: "http://images.example/gallery" }
    });
  try {
    const localPath = `/images/full/${storageObjectKey(ids[0]!, "jpg")}`;
    const original = await app.request(localPath);
    assert.equal(original.status, 200);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), full);
    const etag = original.headers.get("etag")!;
    assert.equal(etag.length, 18);
    for (const method of ["GET", "HEAD"]) {
      const unchanged = await app.request(localPath, {
        method,
        headers: { "If-None-Match": `"unrelated", W/${etag}` }
      });
      assert.equal(unchanged.status, 304);
      assert.equal(await unchanged.text(), "");
      for (const [condition, status] of [
        [etag, 206],
        ["W/" + etag, 200],
        ['"unrelated"', 200]
      ] as const) {
        const ranged = await app.request(localPath, {
          method,
          headers: { Range: "bytes=2-6", "If-Range": condition }
        });
        assert.equal(ranged.status, status);
        assert.deepEqual(
          Buffer.from(await ranged.arrayBuffer()),
          method === "HEAD" ? Buffer.alloc(0) : status === 206 ? full.subarray(2, 7) : full
        );
      }
    }
    for (const defaultSize of ["full", "thumb"] as const) {
      await runtime.runtimeConfigStore.updateRuntimeConfig({ site: { random_size: defaultSize } });
      for (const id of ids) {
        for (const size of [null, "full", "thumb"] as const) {
          const query = `id=${id}${size ? `&size=${size}` : ""}`;
          const selectedSize = size ?? defaultSize;
          const expected = selectedSize === "thumb" ? thumb : full;
          for (const method of ["GET", "HEAD"]) {
            const proxied = await request(`${query}&mode=proxy`, method);
            assert.equal(proxied.status, 200);
            assert.equal(
              proxied.headers.get("content-type"),
              selectedSize === "thumb" ? "image/webp" : "image/jpeg"
            );
            assert.equal(proxied.headers.get("content-length"), String(expected.length));
            assert.match(proxied.headers.get("cache-control")!, /no-store/);
            assert.deepEqual(
              Buffer.from(await proxied.arrayBuffer()),
              method === "HEAD" ? Buffer.alloc(0) : expected
            );
            if (method === "HEAD")
              assert.equal(streams.at(-1)!.destroyed, true, "HEAD releases its opened object");
            if (id === ids[1])
              assert.equal(
                s3Keys.at(-1),
                `gallery/${selectedSize === "thumb" ? "thumbs" : "full"}/${storageObjectKey(id, selectedSize === "thumb" ? "webp" : "jpg")}`
              );
            const redirected = await request(`${query}&mode=redirect`, method);
            assert.equal(redirected.status, 302);
            assert.equal(
              redirected.headers.get("location"),
              `/images/${selectedSize === "thumb" ? "thumbs" : "full"}/${storageObjectKey(id, selectedSize === "thumb" ? "webp" : "jpg")}`
            );
            const json = await request(`${query}&mode=json`, method);
            assert.equal(json.status, 200);
            if (method === "HEAD") assert.equal(await json.text(), "");
            else {
              const body = (await json.json()) as RandomImageJsonResponseDto;
              assert.equal(body.items[0]!.id, id);
              assert.equal(body.items[0]!.width, 1600);
              assert.equal(body.items[0]!.height, 900);
              assert.equal("object_url" in body.items[0]!, size !== "thumb");
              assert.equal("thumb_url" in body.items[0]!, size !== "full");
            }
          }
        }
      }
    }
    for (const size of ["full", "thumb"]) {
      const response = await request(`id=${ids.join(",")}&mode=json&limit=2&size=${size}`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as RandomImageJsonResponseDto;
      assert.deepEqual(body.items.map((item) => item.id).sort(), ids);
      assert.ok(
        body.items.every(
          (item) =>
            "object_url" in item === (size === "full") && "thumb_url" in item === (size === "thumb")
        )
      );
    }
    const seedIds: string[] = [];
    for (const warmed of [false, true]) {
      if (warmed) await coordinator.initializeReadyImageCacheCoordinator();
      for (const size of ["", "&size=full", "&size=thumb"]) {
        const response = await request(`device=all&mode=json&seed=synthetic-size-seed${size}`);
        assert.equal(response.status, 200);
        seedIds.push(((await response.json()) as RandomImageJsonResponseDto).items[0]!.id);
      }
    }
    assert.equal(
      new Set(seedIds).size,
      1,
      "size preserves seeded choice across cold PostgreSQL and warm Redis"
    );
    await runtime.databasePools.pool.query(
      "UPDATE storage_backend SET config=config || $1::jsonb WHERE slug='synthetic-s3'",
      [JSON.stringify({ public_base_url: "https://public.example.com" })]
    );
    runtime.storageRegistry.invalidateStorageBackendRegistry();
    for (const size of ["full", "thumb"] as const) {
      const response = await request(`id=${ids[1]}&mode=redirect&size=${size}`);
      assert.equal(
        response.headers.get("location"),
        `https://public.example.com/gallery/${size === "thumb" ? "thumbs" : "full"}/${storageObjectKey(ids[1]!, size === "thumb" ? "webp" : "jpg")}`
      );
    }
  } finally {
    mock.restoreAll();
    for (const stream of streams) stream.destroy();
  }
});
