const loadServer = (path) => import(new URL(path, 'file:///app/packages/server/dist/'));
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const { default: sharp } = await import(new URL("index.mjs", "file:///app/node_modules/sharp/dist/"));
sharp.cache(false);
const shared = await import(new URL("browser.js", "file:///app/packages/shared/dist/"));
const repository = await loadServer("images/preparation/repository.js");
const service = await loadServer("images/preparation/service.js");
const ownership = await loadServer("images/preparation/process-ownership.js");
const publication = await loadServer("storage/drivers/local-publication.js");
const paths = await loadServer("images/preparation/paths.js");
const encoding = await loadServer("images/variants/encoding.js");
const { startPreparationChild } = await loadServer("images/preparation/child-client.js");
const { initializeRuntimeConfig } = await loadServer("config/runtime-config-store.js");
const database = await loadServer("core/database/pools.js");
initializeRuntimeConfig();
database.configureDatabasePools({ host: process.env.DATABASE_HOST, port: Number(process.env.DATABASE_PORT ?? 5432),
  name: process.env.DATABASE_NAME, user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD });
const { pool } = database;
async function settled(predicate, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let status;
  while (Date.now() < deadline) {
    status = await service.readPreparationStatus();
    if (predicate(status)) return status;
    if (status.block) throw new Error(`${label}: ${status.block}`);
    await delay(100);
  }
  throw new Error(`${label}: timed out: ${JSON.stringify(status)}`);
}
try {
  await assert.rejects(ownership.acquireApplicationHost(), /主服务/);
  const execute = promisify(execFile);
  const cli = "/app/packages/server/dist/normalize-prepare-cli.js";
  assert.equal(JSON.parse((await execute(process.execPath, [cli, "status"], { timeout: 10_000 })).stdout).run_id, null);
  await assert.rejects(execute(process.execPath, [cli, "run"], { timeout: 10_000 }), /主服务或离线执行进程/);
  const profile = shared.defaultPreparationProfile();
  const image = randomUUID();
  const attempt = randomUUID();
  const token = randomUUID();
  const url = `https://images.example.test/${image}.png`;
  const inputBytes = await sharp({ create: { width: 800, height: 500, channels: 3, background: "#4a789d" } }).png().toBuffer();
  const inputHash = createHash("sha256").update(inputBytes).digest("hex");
  // Register a killed encoder and a durable publication with no completion receipt.
  // These are synthetic crash checkpoints in this gate's isolated database and container.
  const child = await startPreparationChild(new AbortController().signal);
  const oldIdentity = child.identity;
  process.kill(oldIdentity.pid, "SIGKILL");
  await child.close();
  assert.equal(await ownership.previousProcessExited(oldIdentity), true);
  const run = await repository.durableTransaction(async (client) => {
    await client.query("INSERT INTO metadata(id,created_by,storage_slug,device,brightness,ext,md5,image_size,original) VALUES($1,'verifyadmin','local','pc','light','png',$2,$3,$4)",
      [image, createHash("md5").update(inputBytes).digest("hex"), inputBytes.length, url]);
    const next = await repository.createPreparationRun(client, profile, 1, 1);
    next.status = "succeeded";
    next.payload.desired_state = "stopped";
    await repository.saveRun(client, next);
    return next;
  });
  const directory = paths.preparationWorkDirectory(run.id, image, attempt);
  await publication.makeDurableDirectory(directory);
  const input = join(directory, "original");
  await writeFile(input, inputBytes);
  await publication.syncFile(input);
  const target = paths.preparationTarget(image, "large");
  const candidate = paths.preparationCandidate(image, "large", token);
  await publication.makeDurableDirectory(dirname(target));
  const encoder = await encoding.createVariantEncoder(input, profile, join(directory, "cache"), 16000, new AbortController().signal);
  const facts = await encoder.encode("large", candidate);
  await encoder.close();
  await publication.publishLocalCandidate(candidate, target);
  const before = await stat(target);
  await repository.saveRecord(pool, {
    run_id: run.id, image_id: image, state: "running",
    data: { source: { original: url, storage_slug: "local", storage_type: "local" },
      input: { path: input, sha256: inputHash, bytes: inputBytes.length }, phase: "发布 large", token,
      child: oldIdentity, attempt, counted: false, retries: 0, error: "", next_retry_at: null, verified: 0,
      variants: { large: { fingerprint: encoding.variantFingerprint(profile, "large"), candidate, expected: facts,
        owner_run: run.id, owner_attempt: attempt, input_sha256: inputHash } } }
  });
  await service.controlPreparation({ action: "start", revision: 1 });
  let status = await settled((value) => value.counts.ready === 1 && value.state === "本轮完成", "recover publication");
  assert.equal(status.completed_attempts, 1);
  assert.equal((await stat(target)).ino, before.ino, "恢复采用已发布文件而不重写");
  for (const variant of shared.imageVariants) {
    const verified = await encoding.verifyVariantFile(paths.preparationTarget(image, variant), new AbortController().signal);
    assert.equal(verified.sha256, status.items[0].variants[variant].sha256);
  }
  const occupied = paths.preparationCandidate(image, "large", randomUUID());
  await writeFile(occupied, "unrelated candidate");
  await assert.rejects(publication.publishLocalCandidate(occupied, target), { code: "EEXIST" });
  assert.equal((await publication.digestLocalFile(target)).sha256, facts.sha256);
  await service.controlPreparation({ action: "verify", revision: status.revision });
  status = await settled((value) => Boolean(value.verified_at) && value.state === "本轮完成", "verify all files");
  assert.equal(status.completed_attempts, 1, "纯核验不增加逻辑尝试计数");
  const { exportPreparationRecords } = await loadServer("images/preparation/export.js");
  const exported = await exportPreparationRecords(new AbortController().signal);
  const lines = (await new Response(exported.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(lines.length >= 2);
  assert.ok(JSON.stringify(lines).includes(image));
  const { previewPreparationImage } = await loadServer("images/preparation/preview.js");
  const preview = await previewPreparationImage(image, "small", new AbortController().signal);
  assert.equal(preview.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), await readFile(paths.preparationTarget(image, "small")));
  // Corruption must invalidate verification, without overwriting unknown bytes.
  await writeFile(paths.preparationTarget(image, "small"), "damaged webp");
  await service.controlPreparation({ action: "verify", revision: status.revision });
  status = await settled((value) => value.state === "本轮完成", "detect corrupt file");
  assert.equal(status.counts.stale, 1);
  assert.equal(status.verified_at, null);
  status = await service.controlPreparation({ action: "stop", revision: status.revision });
  // A failed/stale download remains owned until a changed source is explicitly retried.
  await writeFile(input, inputBytes);
  const changedUrl = `https://images.example.test/${image}-changed.png`;
  await pool.query("UPDATE metadata SET original=$2 WHERE id=$1", [image, changedUrl]);
  status = await service.controlPreparation({ action: "retry", revision: status.revision });
  await assert.rejects(stat(input), { code: "ENOENT" });
  let retried = await repository.readRecord(run.id, image);
  assert.equal(retried.data.input, undefined);
  assert.equal(retried.data.source.original, changedUrl);
  assert.equal(retried.state, "pending");
  // If the DB commit was interrupted after unlink, the old receipt remains safe to retry.
  retried.state = "failed";
  retried.data.source.original = url;
  retried.data.input = { path: input, sha256: inputHash, bytes: inputBytes.length };
  await repository.saveRecord(pool, retried);
  await service.controlPreparation({ action: "retry", revision: status.revision });
  retried = await repository.readRecord(run.id, image);
  assert.equal(retried.data.input, undefined);
  assert.equal(retried.data.source.original, changedUrl);
  assert.equal(retried.state, "pending");
  console.log("[normalize-runtime] killed-child recovery, publication adoption, independent variants, verification, export, preview, host exclusivity, corruption detection and changed-source input cleanup passed");
} finally {
  sharp.cache(false);
  await database.closeDatabasePools();
}
