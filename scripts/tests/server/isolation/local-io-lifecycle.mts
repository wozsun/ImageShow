import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { removeDriverObject } from "./storage-fixture.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";
import { settleWithin } from "./storage-maintenance-fixture.mts";

await runIntegrationScenario(async (runtime) => {
  const { LocalStorageDriver } = await import("../../../../packages/server/src/storage/drivers/local.ts");
  const { collectStorageKeyListing } =
    await import("../../../../packages/server/src/storage/objects/key-listing.ts");
  const driver = new LocalStorageDriver();
  await driver.writeBuffer(
    "large",
    "stream.bin",
    Buffer.from("never-read"),
    "application/octet-stream"
  );
  const reason = new Error("cancel local read");
  await assert.rejects(
    driver.openRead("large", "stream.bin", undefined, { signal: AbortSignal.abort(reason) }),
    (error) => error === reason
  );
  const controller = new AbortController();
  const opened = await driver.openRead("large", "stream.bin", undefined, {
    signal: controller.signal
  });
  let readError: Error | undefined;
  opened.body.once("error", (error) => {
    readError = error;
  });
  const closed = new Promise<void>((resolve) => opened.body.once("close", resolve));
  try {
    controller.abort(reason);
    await settleWithin(closed);
    assert.ok(readError && "code" in readError && readError.code === "ABORT_ERR");
    assert.equal(opened.body.destroyed, true);
  } finally {
    opened.body.destroy();
    await closed;
  }
  const untouched = await driver.openRead("large", "stream.bin");
  const untouchedClosed = once(untouched.body, "close");
  untouched.body.destroy();
  await untouchedClosed;
  await removeDriverObject(driver, "large", "stream.bin");
  assert.equal(await driver.exists("large", "stream.bin"), false);

  await driver.writeBuffer("large", "source.bin", Buffer.from("source"), "application/octet-stream");
  await driver.writeBuffer("large", "target.bin", Buffer.from("target"), "application/octet-stream");
  await assert.rejects(
    driver.writeStream(
      "large",
      "target.bin",
      Readable.from([Buffer.from("source")]),
      6,
      "application/octet-stream"
    )
  );
  assert.equal((await driver.readBuffer("large", "target.bin")).toString(), "target");
  await driver.writeStream(
    "large",
    "copied.bin",
    Readable.from([Buffer.from("source")]),
    6,
    "application/octet-stream"
  );
  assert.equal((await driver.readBuffer("large", "copied.bin")).toString(), "source");
  const listing = await collectStorageKeyListing(driver.listKeys("large"));
  assert.deepEqual(
    { ...listing, keys: listing.keys.toSorted() },
    { complete: true, count: 3, keys: ["copied.bin", "source.bin", "target.bin"] }
  );

  const previousLimit = runtime.runtimeConfigStore.getRuntimeConfig().ingestion.max_file_size_mb;
  const prepared = await import("../../../../packages/server/src/images/ingestion/raw/prepared.ts");
  const { ingestionPreparedFile } = await import("../../../../packages/server/src/images/ingestion/raw/paths.ts");
  const preparedFile = ingestionPreparedFile({
    session_id: "p".repeat(43),
    image_id: "00000000-0000-7000-8000-000000000001",
    generation: "00000000-0000-7000-8000-000000000002",
    execution_token: "00000000-0000-7000-8000-000000000003"
  }, "large");
  await prepared.writeIngestionPreparedFile(preparedFile, Buffer.alloc(2048), new AbortController().signal);
  await runtime.runtimeConfigStore.updateRuntimeConfig({ ingestion: { max_file_size_mb: 0.001 } });
  try {
    await driver.writeBuffer(
      "large",
      "oversized.bin",
      Buffer.alloc(2048),
      "application/octet-stream"
    );
    assert.equal((await driver.readBuffer("large", "oversized.bin", { expectedSize: 2048 })).length, 2048);
    assert.equal((await prepared.readIngestionPreparedFile(preparedFile, 2048)).length, 2048);
    await assert.rejects(driver.readBuffer("large", "oversized.bin", { expectedSize: 2049 }),
      { code: "storage_read_size_mismatch" });
    await assert.rejects(prepared.readIngestionPreparedFile(preparedFile, 2049),
      { code: "storage_read_size_mismatch" });
    await assert.rejects(prepared.readIngestionPreparedFile(preparedFile, 2047),
      { code: "object_too_large" });
    const { openedReadToBuffer } = await import("../../../../packages/server/src/storage/objects/stream-buffer.ts");
    for (const declared of [true, false]) {
      const body = Readable.from([Buffer.alloc(8)]);
      await assert.rejects(openedReadToBuffer({ body, size: declared ? 8 : undefined,
        totalSize: undefined, backend: "local" }, 4), { code: "object_too_large" });
      assert.equal(body.destroyed, true);
    }
  } finally {
    await prepared.removeIngestionPreparedFiles([preparedFile]);
    await runtime.runtimeConfigStore.updateRuntimeConfig({
      ingestion: { max_file_size_mb: previousLimit }
    });
  }

  const storageRoot = resolve(runtime.dataDirectory, "storage");
  assert.equal(storageRoot, join(resolve(runtime.dataDirectory), "storage"));
  for (const root of [join(storageRoot, "large"), storageRoot]) {
    // This scenario owns the entire fresh integration directory.
    await rm(root, { recursive: true, force: true });
    if (root.endsWith("large"))
      assert.deepEqual(await collectStorageKeyListing(driver.listKeys("large")), {
        complete: true,
        count: 0,
        keys: []
      });
    await writeFile(root, "not-a-directory");
    try {
      await assert.rejects(
        root === storageRoot
          ? driver.pruneEmptyDirs()
          : collectStorageKeyListing(driver.listKeys("large")),
        (error) => error instanceof Error && "code" in error && error.code === "ENOTDIR"
      );
    } finally {
      await rm(root);
      await mkdir(root, { recursive: true });
    }
  }
});
