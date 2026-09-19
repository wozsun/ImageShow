import "../support/server-environment.ts";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { before } from "node:test";
import { brotliCompressSync, gzipSync, zstdCompressSync } from "node:zlib";
import { Hono } from "hono";
import { createTestDirectory } from "../support/test-directory.ts";
import { serveNegotiatedStatic } from "../../../packages/server/src/core/http/static-encoding.ts";
import { serveStaticWithValidators } from "../../../packages/server/src/core/http/static-conditional.ts";
import { appendVaryHeader } from "../../../packages/server/src/core/http/headers.ts";
import { handleApiError } from "../../../packages/server/src/core/http/responses.ts";

const source = Buffer.from('const text = "synthetic static content";\n'.repeat(128));
const bodies = {
  identity: source,
  br: brotliCompressSync(source),
  zstd: zstdCompressSync(source),
  gzip: gzipSync(source)
};
type Encoding = keyof typeof bodies;
let app: Hono;

before(async () => {
  const directory = await createTestDirectory("http-static-");
  const root = join(directory, "public");
  await mkdir(join(root, "assets", "nested"), { recursive: true });
  await writeFile(join(directory, "outside.txt"), "synthetic outside file");
  for (const [file, encodings] of [
    ["all.js", ["br", "zstd", "gzip"]],
    ["without-br.js", ["zstd", "gzip"]],
    ["gzip-only.js", ["gzip"]],
    ["plain.js", []],
    ["help.html", ["br", "zstd", "gzip"]],
    ["nested/index.html", ["br", "zstd", "gzip"]]
  ] as const) {
    const path = join(root, "assets", file);
    await writeFile(path, source);
    for (const encoding of encodings) {
      const suffix = { br: ".br", zstd: ".zst", gzip: ".gz" }[encoding];
      await writeFile(path + suffix, bodies[encoding]);
    }
  }
  app = new Hono();
  app.onError((error, c) => handleApiError(c, error));
  const handler = serveNegotiatedStatic(root);
  app.use("/assets/*", async (c, next) => {
    const originalEncoding = c.req.header("Accept-Encoding");
    const originalRange = c.req.header("Range");
    await next();
    assert.equal(c.req.header("Accept-Encoding"), originalEncoding);
    assert.equal(c.req.header("Range"), originalRange);
    appendVaryHeader(c, "Accept-Encoding");
    c.header("Cache-Control", c.res.status < 400 ? "public, max-age=31536000, immutable" : "no-store");
  });
  app.use("/assets/*", async (c, next) => await serveStaticWithValidators(c, handler) ?? next());
});

const cases: Array<[string | undefined, Encoding | 406]> = [
  [undefined, "identity"], ["", "identity"], ["identity", "identity"],
  ["br", "br"], ["zstd", "zstd"], ["gzip", "gzip"],
  ["gzip, zstd, br", "br"], ["GZIP, ZsTd", "zstd"],
  ["br;q=0.2, zstd;q=0.8, gzip;q=1", "gzip"],
  ["br;q=0, zstd;q=0.7, gzip;q=0.7", "zstd"],
  ["*", "br"], ["*;q=0.8, br;q=0", "zstd"],
  ["*;q=0, gzip;q=1", "gzip"], ["*;q=0, identity;q=0.5", "identity"],
  ["br;q=0.5, identity;q=1", "identity"], ["br;q=1, identity;q=0.5", "br"],
  ["br;q=0.5, identity;q=0.5", "br"], ["unknown", "identity"],
  ["br;q=0, zstd;q=0, gzip;q=0", "identity"],
  ["*;q=0", 406], ["unknown, identity;q=0", 406],
  ["br;q=0, BR;q=1, *;q=0", 406],
  ["br;q=invalid, *;q=0", 406], ["br;q=1.1, *;q=0", 406]
];

test("[Server/静态HTTP] 编码偏好与 GET / HEAD 选择同一可接受表示", async () => {
  for (const [accept, expected] of cases) {
    for (const method of ["GET", "HEAD"]) {
      const headers = new Headers();
      if (accept !== undefined) headers.set("Accept-Encoding", accept);
      const response = await app.request("/assets/all.js", { method, headers });
      const label = `${method} ${accept ?? "(missing)"}`;
      assert.equal(response.status, expected === 406 ? 406 : 200, label);
      assert.match(response.headers.get("Vary") ?? "", /Accept-Encoding/i, label);
      const body = Buffer.from(await response.arrayBuffer());
      if (expected === 406) {
        assert.equal(body.length, 0, label);
        assert.equal(response.headers.get("Content-Encoding"), null, label);
        assert.equal(response.headers.get("ETag"), null, label);
        assert.equal(response.headers.get("Cache-Control"), "no-store", label);
      } else {
        assert.equal(response.headers.get("Content-Encoding"), expected === "identity" ? null : expected, label);
        assert.equal(Number(response.headers.get("Content-Length")), bodies[expected].length, label);
        assert.deepEqual(body, method === "HEAD" ? Buffer.alloc(0) : bodies[expected], label);
        assert.ok(response.headers.get("ETag"), label);
      }
    }
  }
});

test("[Server/静态HTTP] 缺失高权重副本按剩余偏好回退，缺失文件保持 404", async () => {
  for (const [file, accept, expected] of [
    ["without-br.js", "br, zstd, gzip", "zstd"],
    ["without-br.js", "br;q=1, gzip;q=0.8, zstd;q=0.2", "gzip"],
    ["gzip-only.js", "br;q=1, zstd;q=0.8, gzip;q=0.2, identity;q=0", "gzip"],
    ["gzip-only.js", "br;q=1, identity;q=0.8, gzip;q=0.2", "identity"],
    ["plain.js", "br;q=1, zstd;q=0.8, gzip;q=0.2", "identity"],
    ["plain.js", "br, identity;q=0", 406],
    ["missing.js", "*;q=0", 404],
    ["%5c..%5coutside.txt", "br", 404]
  ] as const) {
    const response = await app.request(`/assets/${file}`, { headers: { "Accept-Encoding": accept } });
    assert.equal(response.status, typeof expected === "number" ? expected : 200, file);
    const body = Buffer.from(await response.arrayBuffer());
    if (typeof expected === "string") {
      assert.equal(response.headers.get("Content-Encoding"), expected === "identity" ? null : expected);
      assert.deepEqual(body, bodies[expected]);
    } else assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
});

test("[Server/静态HTTP] 静态 HTML 与目录索引保持 MIME 和编码协商", async () => {
  for (const path of ["/assets/help.html", "/assets/nested/"]) {
    const response = await app.request(path, { headers: { "Accept-Encoding": "zstd" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /^text\/html/);
    assert.equal(response.headers.get("Content-Encoding"), "zstd");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bodies.zstd);
  }
});

test("[Server/静态HTTP] 各编码验证器与 304、单范围和 If-Range 一致", async () => {
  const etags = new Set<string>();
  for (const encoding of ["identity", "br", "zstd", "gzip"] as const) {
    const headers = { "Accept-Encoding": encoding };
    const full = await app.request("/assets/all.js", { headers });
    const etag = full.headers.get("ETag")!;
    assert.match(etag, /^W\/"[A-Za-z0-9_-]{16}"$/);
    const modified = full.headers.get("Last-Modified")!;
    etags.add(etag);
    const expected = Buffer.from(await full.arrayBuffer());
    const conditions: Record<string, string>[] = [{ "If-None-Match": etag }, { "If-Modified-Since": modified }];
    for (const condition of conditions) {
      for (const method of ["GET", "HEAD"]) {
        const response = await app.request("/assets/all.js", { method, headers: { ...headers, ...condition } });
        assert.equal(response.status, 304);
        assert.equal((await response.arrayBuffer()).byteLength, 0);
        for (const name of ["Content-Length", "Content-Encoding", "Content-Range"]) assert.equal(response.headers.get(name), null);
        assert.equal(response.headers.get("ETag"), etag);
        assert.match(response.headers.get("Vary") ?? "", /Accept-Encoding/i);
      }
    }
    const precedence = await app.request("/assets/all.js", { headers: {
      ...headers, "If-None-Match": '"different"', "If-Modified-Since": modified
    } });
    assert.equal(precedence.status, 200);
    assert.deepEqual(Buffer.from(await precedence.arrayBuffer()), expected);
    const headRange = await app.request("/assets/all.js", { method: "HEAD", headers: { ...headers, Range: "bytes=0-7" } });
    assert.equal(headRange.status, 200);
    assert.equal(Number(headRange.headers.get("Content-Length")), expected.length);
    assert.equal((await headRange.arrayBuffer()).byteLength, 0);
    const conditionalRange = await app.request("/assets/all.js", { headers: { ...headers, Range: "bytes=0-7", "If-None-Match": etag } });
    assert.equal(conditionalRange.status, 304);
    assert.equal((await conditionalRange.arrayBuffer()).byteLength, 0);
    for (const [range, start, end] of [["bytes=0-7", 0, 7], ["bytes=-5", expected.length - 5, expected.length - 1], [`bytes=${expected.length - 3}-`, expected.length - 3, expected.length - 1]] as const) {
      const response = await app.request("/assets/all.js", { headers: { ...headers, Range: range } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get("ETag"), etag);
      assert.equal(response.headers.get("Content-Range"), `bytes ${start}-${end}/${expected.length}`);
      assert.equal(Number(response.headers.get("Content-Length")), end - start + 1);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected.subarray(start, end + 1));
    }
    for (const [ifRange, status] of [[modified, 206], [etag, 200], ['"different"', 200], ["Thu, 01 Jan 1970 00:00:00 GMT", 200]] as const) {
      const response = await app.request("/assets/all.js", { headers: { ...headers, Range: "bytes=0-7", "If-Range": ifRange } });
      assert.equal(response.status, status);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), status === 206 ? expected.subarray(0, 8) : expected);
    }
    for (const range of [`bytes=${expected.length}-`, "bytes=0-1,3-4", "bytes=-0"]) {
      const response = await app.request("/assets/all.js", { headers: { ...headers, Range: range } });
      assert.equal(response.status, 416);
      assert.equal(response.headers.get("Content-Range"), `bytes */${expected.length}`);
      assert.equal(response.headers.get("Content-Encoding"), null);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      await response.arrayBuffer();
    }
  }
  assert.equal(etags.size, 4, "each encoded representation has a distinct validator");
  const weightedRange = await app.request("/assets/without-br.js", { headers: {
    "Accept-Encoding": "br;q=1, gzip;q=0.8, zstd;q=0.2", Range: "bytes=0-7",
    "If-None-Match": [...etags][0]!
  } });
  assert.equal(weightedRange.status, 206);
  assert.equal(weightedRange.headers.get("Content-Encoding"), "gzip");
  assert.deepEqual(Buffer.from(await weightedRange.arrayBuffer()), bodies.gzip.subarray(0, 8));
});
