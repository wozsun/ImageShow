import type { StorageConfig } from "../backends/config.ts";
import type { StorageDriver } from "./driver.ts";
import { LocalStorageDriver } from "./local.ts";
import { S3StorageDriver } from "./s3.ts";

export function createStorageDriver(config: StorageConfig): StorageDriver {
  return config.type === "local" ? new LocalStorageDriver() : new S3StorageDriver(config);
}
