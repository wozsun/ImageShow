import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { removeDriverObject } from "./storage-fixture.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";
import { settleWithin } from "./storage-maintenance-fixture.mts";

await runIntegrationScenario(async (runtime) => {
  const { LocalBackend } = await import("../../../../packages/server/src/storage/drivers/local.ts");
  const { collectStorageKeyListing } = await import("../../../../packages/server/src/storage/objects/key-listing.ts");
  const driver = new LocalBackend();
  await driver.writeBuffer("full", "stream.bin", Buffer.from("never-read"), "application/octet-stream");
  const reason = new Error("cancel local read");
  await assert.rejects(driver.openRead("full", "stream.bin", undefined, { signal: AbortSignal.abort(reason) }), error => error === reason);
  const controller = new AbortController();
  const opened = await driver.openRead("full", "stream.bin", undefined, { signal: controller.signal });
  let readError: Error | undefined;
  opened.body.once("error", error => { readError = error; });
  const closed = new Promise<void>(resolve => opened.body.once("close", resolve));
  try {
    controller.abort(reason);
    await settleWithin(closed);
    assert.ok(readError && "code" in readError && readError.code === "ABORT_ERR");
    assert.equal(opened.body.destroyed, true);
  } finally { opened.body.destroy(); await closed; }
  const untouched = await driver.openRead("full", "stream.bin");
  const untouchedClosed = once(untouched.body, "close");
  untouched.body.destroy();
  await untouchedClosed;
  await removeDriverObject(driver, "full", "stream.bin");
  assert.equal(await driver.exists("full", "stream.bin"), false);

  await driver.writeBuffer("full", "source.bin", Buffer.from("source"), "application/octet-stream");
  await driver.writeBuffer("full", "target.bin", Buffer.from("target"), "application/octet-stream");
  await assert.rejects(driver.copy("full", "source.bin", "full", "target.bin"));
  assert.equal((await driver.readBuffer("full", "target.bin")).toString(), "target");
  await driver.copy("full", "source.bin", "full", "copied.bin");
  assert.equal((await driver.readBuffer("full", "copied.bin")).toString(), "source");
  const listing = await collectStorageKeyListing(driver.listKeys("full"));
  assert.deepEqual({ ...listing, keys: listing.keys.toSorted() }, { complete: true, count: 3, keys: ["copied.bin", "source.bin", "target.bin"] });

  const previousLimit = runtime.runtimeConfigStore.getRuntimeConfig().ingestion.max_file_size_mb;
  await runtime.runtimeConfigStore.updateRuntimeConfig({ ingestion: { max_file_size_mb: 0.001 } });
  try {
    await driver.writeBuffer("full", "oversized.bin", Buffer.alloc(2048), "application/octet-stream");
    await assert.rejects(driver.readBuffer("full", "oversized.bin"), error => error instanceof Error && "code" in error && error.code === "object_too_large");
  } finally { await runtime.runtimeConfigStore.updateRuntimeConfig({ ingestion: { max_file_size_mb: previousLimit } }); }

  const storageRoot = resolve(runtime.dataDirectory, "storage");
  assert.equal(storageRoot, join(resolve(runtime.dataDirectory), "storage"));
  for (const root of [join(storageRoot, "full"), storageRoot]) {
    // This scenario owns the entire fresh integration directory.
    await rm(root, { recursive: true, force: true });
    if (root.endsWith("full")) assert.deepEqual(await collectStorageKeyListing(driver.listKeys("full")), { complete: true, count: 0, keys: [] });
    await writeFile(root, "not-a-directory");
    try {
      await assert.rejects(root === storageRoot ? driver.pruneEmptyDirs() : collectStorageKeyListing(driver.listKeys("full")),
        error => error instanceof Error && "code" in error && error.code === "ENOTDIR");
    } finally { await rm(root); await mkdir(root, { recursive: true }); }
  }
});
