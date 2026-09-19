import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import {
  brotliDecompress, gunzip, constants, createZstdDecompress
} from "node:zlib";
import { compressStaticAsset, staticAssetCompression } from "../../build/static-asset-compression.mjs";
import { createTestDirectory, cleanupTestDirectories } from "../support/test-directory.ts";
import { runProcess } from "../support/process-runner.ts";

async function decodeZstd(body) {
  const chunks = [];
  const decoder = createZstdDecompress({
    params: { [constants.ZSTD_d_windowLogMax]: 23 }
  });
  for await (const chunk of Readable.from([body]).pipe(decoder)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function zstdWindowSize(frame) {
  assert.equal(frame.readUInt32LE(0), 0xfd2fb528);
  const descriptor = frame[4];
  if (!(descriptor & 0x20)) {
    const window = frame[5];
    const base = 2 ** (10 + (window >> 3));
    return base + (base / 8) * (window & 7);
  }
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 3];
  const sizeFlag = descriptor >> 6;
  const sizeBytes = [1, 2, 4, 8][sizeFlag];
  const offset = 5 + dictionaryBytes;
  const size = sizeBytes === 8 ? Number(frame.readBigUInt64LE(offset)) : frame.readUIntLE(offset, sizeBytes);
  return size + (sizeFlag === 1 ? 256 : 0);
}

export async function verifyStaticCompression() {
  const repeated = Buffer.from("const value='synthetic';".repeat(12));
  const noisy = Buffer.alloc(16 * 1024);
  let state = 12345;
  for (let index = 0; index < noisy.length; index += 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    noisy[index] = state & 255;
  }
  const large = Buffer.alloc(9 * 1024 * 1024, "synthetic large HTTP asset; ");
  const fixtures = [
    ["empty.txt", Buffer.alloc(0)], ["tiny.js", Buffer.from("x")],
    ["small.js", repeated], ["noisy.txt", noisy],
    ["config.json", Buffer.from(JSON.stringify({ values: Array(80).fill("synthetic") }))],
    ["help.html", Buffer.from("<p>synthetic static HTML</p>".repeat(80))],
    ["large.js", large]
  ];
  for (const [name, source] of fixtures) {
    const compressed = await compressStaticAsset(name, source);
    for (const [field, decoder] of [["brotli", promisify(brotliDecompress)], ["gzip", promisify(gunzip)], ["zstd", decodeZstd]]) {
      const body = compressed[field];
      if (body) {
        assert.ok(body.length < source.length, `${name}: ${field} must save bytes`);
        assert.deepEqual(await decoder(body), source, `${name}: ${field} roundtrip`);
      }
    }
    if (compressed.zstd) assert.ok(zstdWindowSize(compressed.zstd) <= 8 * 1024 * 1024, `${name}: HTTP window limit`);
    if (source.length <= 1) assert.equal(compressed.defaultEncoding, "identity");
    assert.equal(compressed.rawBytes, source.length);
    assert.equal(compressed.effectiveBytes, Math.min(compressed.rawBytes, compressed.brotliBytes, compressed.zstdBytes, compressed.gzipBytes));
  }
  const small = await compressStaticAsset("small.js", repeated);
  assert.ok(small.brotli && small.zstd && small.gzip, "small compressible bodies retain every beneficial encoding");
  assert.equal(small.defaultEncoding, "br");
  assert.equal(small.defaultBytes, small.brotli.length);
  for (const name of ["binary.png", "asset.js.gz", "asset.js.br", "asset.js.zst"]) {
    const skipped = await compressStaticAsset(name, repeated);
    assert.equal(skipped.defaultEncoding, "identity", name);
    assert.equal(skipped.defaultBytes, repeated.length, name);
  }

  // Exercise the production assembler in an independent workspace, then rebuild
  // after replacing a compressible asset with a body best served as identity.
  const directory = await createTestDirectory("static-assembly-");
  const input = resolve(directory, "packages/web/dist");
  const output = resolve(directory, "packages/server/dist/public");
  try {
    await mkdir(resolve(directory, "scripts/build"), { recursive: true });
    await mkdir(resolve(directory, "packages/server/dist"), { recursive: true });
    await mkdir(resolve(input, "assets/nested"), { recursive: true });
    await mkdir(resolve(input, ".vite"), { recursive: true });
    for (const file of ["copy-server-assets.mjs", "static-asset-compression.mjs"]) {
      await cp(resolve(import.meta.dirname, "../../build", file), resolve(directory, "scripts/build", file));
    }
    await writeFile(resolve(directory, "packages/server/schema.sql"), "SELECT 1;\n");
    const template = "<html><title>dynamic template</title></html>";
    await writeFile(resolve(input, "index.html"), template);
    for (const file of ["assets/app.js", "assets/help.html", "assets/nested/index.html"]) await writeFile(resolve(input, file), repeated);
    const assemble = () => runProcess(process.execPath, [resolve(directory, "scripts/build/copy-server-assets.mjs")], { cwd: directory });
    await assemble();
    assert.equal(await readFile(resolve(output, "index.html"), "utf8"), template);
    for (const file of ["assets/app.js", "assets/help.html", "assets/nested/index.html"]) {
      assert.deepEqual(await decodeZstd(await readFile(resolve(output, file + ".zst"))), repeated);
    }
    await writeFile(resolve(input, "assets/app.js"), "x");
    await assemble();
    const report = JSON.parse(await readFile(resolve(input, ".vite/static-compression-report.json"), "utf8"));
    const app = report.assets.find((asset) => asset.file === "assets/app.js");
    assert.equal(app.defaultEncoding, "identity");
    assert.equal(app.defaultBytes, 1);
    assert.equal(report.policy.zstdLevel, staticAssetCompression.zstdLevel);
    assert.equal(await readFile(resolve(output, "assets/app.js"), "utf8"), "x");
    for (const suffix of [".br", ".zst", ".gz"]) {
      await assert.rejects(readFile(resolve(output, "assets/app.js" + suffix)), { code: "ENOENT" }, "rebuild must not serve an obsolete representation");
    }
  } finally {
    await cleanupTestDirectories();
  }
}
