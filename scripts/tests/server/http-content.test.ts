import "../support/server-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { contentResponse, createContentRepresentation, type ContentRepresentation } from "../../../packages/server/src/core/http/content-response.ts";
import { createApiSuccessSnapshot } from "../../../packages/server/src/core/http/responses.ts";
import { createEncodedContentCache } from "../../../packages/server/src/core/http/encoded-content.ts";
import { logger } from "../../../packages/server/src/core/logger.ts";

test("[Server/内容HTTP] JSON 快照复用正文与验证器，发布变化后失效", async () => {
  let projections = 0;
  const snapshot = createApiSuccessSnapshot((source: { title: string; private: number }) => {
    projections++;
    return { title: source.title };
  });
  const first = { title: "合成配置 😀", private: 1 };
  const representation = snapshot(first);
  assert.equal(representation.body, JSON.stringify({ ok: true, title: first.title }));
  assert.equal(representation.byteLength, Buffer.byteLength(String(representation.body)));
  for (let i = 0; i < 10; i++) assert.equal(snapshot(first), representation);
  assert.equal(projections, 1);
  assert.equal(snapshot({ ...first, private: 2 }), representation);
  const changed = snapshot({ ...first, title: "新配置" });
  assert.notEqual(changed.etag, representation.etag);
  const response = contentResponse(changed, {
    cacheControl: "private, no-cache", contentType: "application/json", ifNoneMatch: representation.etag
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, title: "新配置" });
});

test("[Server/内容HTTP] 原生编码正文、长度、条件响应与 HEAD 一致", async () => {
  const identity = createContentRepresentation("<html>合成页面内容 😀</html>".repeat(100));
  const select = createEncodedContentCache();
  assert.equal(select(identity, "br, gzip"), identity);
  assert.equal(select(identity, "br, identity;q=0"), null);
  const deadline = Date.now() + 5_000;
  while (select(identity, "br")?.encoding !== "br" || select(identity, "gzip")?.encoding !== "gzip") {
    assert.ok(Date.now() < deadline, "native encoders should complete");
    await setTimeout(1);
  }
  const app = new Hono();
  app.get("/", (c) => {
    const representation = select(identity, c.req.header("Accept-Encoding"));
    return representation ? contentResponse(representation, {
      cacheControl: "public, max-age=0", contentType: "text/html",
      headers: { Vary: "Accept-Encoding" }, ifNoneMatch: c.req.header("If-None-Match")
    }) : new Response(null, { status: 406, headers: { Vary: "Accept-Encoding", "Cache-Control": "no-store" } });
  });
  for (const [accept, encoding] of [
    ["br, gzip", "br"], ["BR;q=0.5, gzip;q=1", "gzip"],
    ["br;q=0.5, identity;q=1", undefined], ["", undefined]
  ] as const) {
    const response = await app.request("/", { headers: { "Accept-Encoding": accept } });
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.headers.get("Content-Encoding"), encoding ?? null);
    assert.equal(response.headers.get("Content-Length"), String(body.length));
    assert.equal(response.headers.get("ETag"), identity.etag);
    assert.equal(response.headers.get("Vary"), "Accept-Encoding");
    const decoded = encoding === "br" ? brotliDecompressSync(body) : encoding === "gzip" ? gunzipSync(body) : body;
    assert.equal(decoded.toString(), identity.body);
    for (const method of ["GET", "HEAD"]) {
      const cached = await app.request("/", { method, headers: {
        "Accept-Encoding": accept, "If-None-Match": identity.etag
      } });
      assert.equal(cached.status, 304);
      assert.equal((await cached.arrayBuffer()).byteLength, 0);
      assert.equal(cached.headers.get("Content-Length"), null);
      assert.equal(cached.headers.get("Content-Encoding"), null);
      assert.equal(cached.headers.get("Vary"), "Accept-Encoding");
    }
    const head = await app.request("/", { method: "HEAD", headers: { "Accept-Encoding": accept } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("Content-Length"), String(body.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
  assert.equal((await app.request("/", { headers: { "Accept-Encoding": "*;q=0" } })).status, 406);
});

test("[Server/内容HTTP] 编码并发有界、只处理最新等待内容且失败不重复占用资源", async (t) => {
  const calls: Array<{
    source: ContentRepresentation;
    encoding: string;
    resolve: (body: Buffer<ArrayBuffer>) => void;
    reject: (error: Error) => void;
  }> = [];
  const encoder = (encoding: string) => (source: ContentRepresentation) => new Promise<Buffer<ArrayBuffer>>((resolve, reject) => {
    calls.push({ source, encoding, resolve, reject });
  });
  const warnings: unknown[] = [];
  t.mock.method(logger, "warn", (...args: unknown[]) => { warnings.push(args); });
  const select = createEncodedContentCache({ br: encoder("br"), gzip: encoder("gzip") });
  const a = createContentRepresentation("first source ".repeat(100));
  const b = createContentRepresentation("superseded source ".repeat(100));
  const c = createContentRepresentation("current source ".repeat(100));
  select(a, "br");
  select(b, "br");
  select(c, "br");
  assert.equal(calls.length, 2);
  for (const call of calls.slice()) call.resolve(Buffer.from("old encoding"));
  await setImmediate();
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(call => call.source), [a, a, c, c]);
  assert.equal(select(c, "br, identity;q=0"), null, "old generation cannot populate current variants");
  calls[2]!.reject(new Error("synthetic encoder failure"));
  calls[3]!.resolve(Buffer.from("current gzip"));
  await setImmediate();
  for (let i = 0; i < 10; i++) {
    assert.equal(select(c, "br"), c);
    assert.equal(select(c, "br, gzip, identity;q=0")?.encoding, "gzip");
  }
  assert.equal(calls.length, 4);
  assert.equal(warnings.length, 1);
  const next = createContentRepresentation("next source ".repeat(100));
  select(next, "br");
  assert.equal(calls.length, 6);
  calls[4]!.resolve(Buffer.from("new br"));
  calls[5]!.resolve(Buffer.from("new gzip"));
  await setImmediate();
  assert.equal(select(next, "br")?.etag, next.etag);
  assert.equal(select(next, "br")?.encoding, "br");
  const oversized = createContentRepresentation("x".repeat(1024 * 1024 + 1));
  assert.equal(select(oversized, "br"), oversized);
  assert.equal(select(oversized, "br, identity;q=0"), null);
  assert.equal(calls.length, 6);
});

test("[Server/内容HTTP] 不缓存变大的编码，同步编码失败保持原文可用", async (t) => {
  t.mock.method(logger, "warn", () => {});
  let calls = 0;
  const identity = createContentRepresentation("small");
  const select = createEncodedContentCache({
    br: async () => Buffer.from("larger than source"),
    gzip: () => { calls++; throw new Error("synthetic immediate failure"); }
  });
  assert.equal(select(identity, "br, gzip"), identity);
  await setImmediate();
  assert.equal(select(identity, "br, gzip"), identity);
  assert.equal(select(identity, "br, gzip, identity;q=0"), null);
  assert.equal(calls, 1);
});
