import type { StorageConfig } from "./backend-config.ts";
import type { StorageDriver } from "./driver.ts";
import { LocalBackend } from "./local-backend.ts";
import { S3Backend } from "./s3-backend.ts";

export function createStorageDriver(config: StorageConfig): StorageDriver {
  return config.type === "local" ? new LocalBackend() : new S3Backend(config);
}
