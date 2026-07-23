import type { StorageConfig } from "./backend-config.ts";
import type { StorageDriver } from "./driver.ts";
import { LocalBackend } from "./local-backend.ts";
import { S3Backend } from "./s3-backend.ts";
import { WebdavBackend } from "./webdav-backend.ts";

export function createStorageDriver(config: StorageConfig): StorageDriver {
  if (config.type === "s3") return new S3Backend(config);
  if (config.type === "webdav") return new WebdavBackend(config);
  return new LocalBackend();
}
