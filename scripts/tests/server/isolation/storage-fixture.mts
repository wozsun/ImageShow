import assert from "node:assert/strict";
import type { StorageDriver } from "../../../../packages/server/src/storage/drivers/driver.ts";

export function controlledStorageDriver(overrides: Partial<StorageDriver>): StorageDriver {
  const unexpected = (): never => { throw new Error("unexpected storage fixture operation"); };
  return {
    exists: unexpected, openRead: unexpected, readBuffer: unexpected,
    writeBuffer: unexpected, writeStream: unexpected, removeObjects: unexpected,
    serverCopySource: unexpected, supportsServerCopySource: unexpected,
    copyFromServerSource: unexpected, listKeys: unexpected, selfTest: unexpected,
    pruneEmptyDirs: unexpected, ...overrides
  };
}

export async function removeDriverObject(
  driver: StorageDriver,
  prefix: "full" | "thumbs",
  key: string
) {
  const [result] = await driver.removeObjects([{ prefix, key }]);
  assert.ok(result?.status === "removed" || result?.status === "missing",
    "test fixture storage object must be removed");
}
