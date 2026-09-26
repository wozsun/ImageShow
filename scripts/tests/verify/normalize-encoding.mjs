const loadServer = (path) => import(new URL(path, 'file:///app/packages/server/dist/'));
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after } from 'node:test';
const { default: sharp } = await import(new URL('index.mjs', 'file:///app/node_modules/sharp/dist/'));
sharp.cache(false);
const { defaultPreparationProfile, imageVariants } = await import(new URL('browser.js', 'file:///app/packages/shared/dist/'));
const { createVariantEncoder, verifyVariantFile } = await loadServer('images/variants/encoding.js');
const temporary = [];
async function createTestDirectory(prefix) {
  const directory = await mkdtemp(join('/tmp/', prefix));
  temporary.push(directory);
  return directory;
}
after(async () => {
  sharp.cache(false);
  for (const directory of temporary) await rm(directory, { recursive: true, force: true });
});
test("[Server/三档预生成] 三档独立文件、等价编码复用和禁止放大", async (t) => {
  const directory = await createTestDirectory("preparation-encoding-");
  const input = join(directory, "input.png");
  await sharp({ create: { width: 96, height: 64, channels: 3, background: "#347abc" } }).png().toFile(input);
  const encoder = await createVariantEncoder(input, defaultPreparationProfile(), join(directory, "cache"), 16000, new AbortController().signal);
  const originalWebp = sharp.prototype.webp;
  let encodes = 0;
  t.mock.method(sharp.prototype, "webp", function (options) {
    encodes += 1;
    return originalWebp.call(this, options);
  });
  try {
    const paths = [];
    for (const variant of imageVariants) {
      const path = join(directory, `${variant}.webp`);
      paths.push(path);
      const facts = await encoder.encode(variant, path);
      assert.deepEqual([facts.width, facts.height, facts.quality, facts.effort, facts.passthrough], [96, 64, 80, 4, false]);
      assert.equal(facts.over_target, false);
    }
    assert.equal(encodes, 1);
    assert.deepEqual(await readFile(paths[0]), await readFile(paths[1]));
    assert.deepEqual(await readFile(paths[1]), await readFile(paths[2]));
    assert.equal(new Set((await Promise.all(paths.map((path) => stat(path)))).map((info) => info.ino)).size, 3);
  } finally { await encoder.close(); }
});

test("[Server/三档预生成] 仅大图直通 WebP，较小档始终编码且限制长边", async () => {
  const directory = await createTestDirectory("preparation-webp-");
  const input = join(directory, "input.webp");
  await sharp({ create: { width: 800, height: 400, channels: 3, background: "#456789" } }).webp({ lossless: true }).toFile(input);
  const profile = defaultPreparationProfile();
  const encoder = await createVariantEncoder(input, profile, join(directory, "cache"), 16000, new AbortController().signal);
  try {
    const large = join(directory, "large.webp");
    assert.equal((await encoder.encode("large", large)).passthrough, true);
    assert.deepEqual(await readFile(large), await readFile(input));
    assert.equal((await encoder.encode("middle", join(directory, "middle.webp"))).passthrough, false);
    const small = await encoder.encode("small", join(directory, "small.webp"));
    assert.deepEqual([small.width, small.height, small.passthrough], [600, 300, false]);
  } finally { await encoder.close(); }
});

test("[Server/三档预生成] 质量触底允许超限且损坏文件不能通过完整核验", async () => {
  const directory = await createTestDirectory("preparation-floor-");
  const raw = Buffer.alloc(512 * 512 * 3);
  let seed = 123456789;
  for (let i = 0; i < raw.length; i += 1) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; raw[i] = seed >>> 24; }
  const input = join(directory, "input.png");
  await sharp(raw, { raw: { width: 512, height: 512, channels: 3 } }).png().toFile(input);
  const profile = defaultPreparationProfile();
  profile.small.max_size_kb = 8;
  profile.small.min_quality = 63;
  const signal = new AbortController().signal;
  const encoder = await createVariantEncoder(input, profile, join(directory, "cache"), 16000, signal);
  try {
    const output = join(directory, "small.webp");
    const facts = await encoder.encode("small", output);
    assert.equal(facts.quality, 63);
    assert.equal(facts.over_target, true);
    assert.ok(facts.bytes > 8192);
    const reference = await sharp(input).rotate().resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true }).webp({ quality: 63, effort: 4 }).toBuffer();
    assert.deepEqual(await readFile(output), reference);
    await writeFile(output, reference.subarray(0, Math.floor(reference.length / 2)));
    await assert.rejects(verifyVariantFile(output, signal));
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(verifyVariantFile(input, aborted.signal), { name: "AbortError" });
  } finally { await encoder.close(); }
});

test("[Server/三档预生成] 方向、透明、首帧与动画原 WebP 保留", async () => {
  const directory = await createTestDirectory("preparation-formats-");
  const signal = new AbortController().signal;
  for (const format of ["jpeg", "png", "gif", "avif"]) {
    const input = join(directory, `source.${format}`);
    await sharp({ create: { width: 96, height: 64, channels: 4, background: { r: 60, g: 120, b: 180, alpha: 0.5 } } })
      .withMetadata({ orientation: 6 }).toFormat(format).toFile(input);
    const source = await sharp(input).metadata();
    const encoder = await createVariantEncoder(input, defaultPreparationProfile(), join(directory, `cache-${format}`), 16000, signal);
    try {
      const path = join(directory, `${format}.webp`);
      const facts = await encoder.encode("large", path);
      const rotated = (source.orientation ?? 1) >= 5;
      assert.deepEqual([facts.width, facts.height], rotated ? [source.height, source.width] : [source.width, source.height]);
      if (format === "png") assert.equal((await sharp(path).metadata()).hasAlpha, true);
    } finally { await encoder.close(); }
  }
  const animation = join(directory, "animated.webp");
  const raw = Buffer.alloc(8 * 8 * 3, 80);
  raw.fill(180, 8 * 4 * 3);
  await sharp(raw, { raw: { width: 8, height: 8, channels: 3, pageHeight: 4 } }).webp({ delay: [50, 50], loop: 0 }).toFile(animation);
  assert.equal((await sharp(animation, { animated: true }).metadata()).pages, 2);
  const encoder = await createVariantEncoder(animation, defaultPreparationProfile(), join(directory, "animation-cache"), 16000, signal);
  try {
    const large = join(directory, "animation-large.webp");
    assert.equal((await encoder.encode("large", large)).passthrough, true);
    assert.deepEqual(await readFile(large), await readFile(animation));
    const small = join(directory, "animation-small.webp");
    await encoder.encode("small", small);
    assert.equal((await sharp(small).metadata()).pages ?? 1, 1);
  } finally { await encoder.close(); }
});

test("[Server/三档预生成] 大图直通阈值相等时重新编码，不同 effort 不误复用", async (t) => {
  const directory = await createTestDirectory("preparation-threshold-");
  const original = await sharp({ create: { width: 96, height: 64, channels: 3, background: "#5b6d8f" } }).webp().toBuffer();
  const padded = Buffer.alloc(256 * 1024);
  original.copy(padded);
  padded.writeUInt32LE(padded.length - 8, 4);
  padded.write("JUNK", original.length, "ascii");
  padded.writeUInt32LE(padded.length - original.length - 8, original.length + 4);
  const input = join(directory, "input.webp");
  await writeFile(input, padded);
  const profile = defaultPreparationProfile();
  profile.large.max_size_kb = 256;
  profile.middle.max_size_kb = 128;
  profile.middle.webp_effort = 3;
  profile.small.webp_effort = 5;
  const encoder = await createVariantEncoder(input, profile, join(directory, "cache"), 16000, new AbortController().signal);
  const originalWebp = sharp.prototype.webp;
  let encodes = 0;
  t.mock.method(sharp.prototype, "webp", function (options) { encodes += 1; return originalWebp.call(this, options); });
  try {
    for (const variant of imageVariants) assert.equal((await encoder.encode(variant, join(directory, `${variant}.webp`))).passthrough, false);
    assert.equal(encodes, 3);
  } finally { await encoder.close(); }
});
