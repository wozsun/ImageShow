import type { StorageConfig } from "../backends/config.ts";
import type { StorageDriver } from "./driver.ts";
import { LocalBackend } from "./local.ts";
import { S3Backend } from "./s3.ts";

export function createStorageDriver(config: StorageConfig): StorageDriver {
  return config.type === "local" ? new LocalBackend() : new S3Backend(config);
}
