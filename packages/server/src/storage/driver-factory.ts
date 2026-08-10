import type {
  StorageConfig,
  StorageConfigByType
} from "./backend-config.ts";
import type { StorageDriver } from "./driver.ts";
import { LocalBackend } from "./local-backend.ts";
import { S3Backend } from "./s3-backend.ts";

const storageDriverFactories = {
  local: (_config: StorageConfigByType["local"]) => new LocalBackend(),
  s3: (config: StorageConfigByType["s3"]) => new S3Backend(config)
} satisfies {
  [Type in keyof StorageConfigByType]: (
    config: StorageConfigByType[Type]
  ) => StorageDriver;
};

export function createStorageDriver(config: StorageConfig): StorageDriver {
  switch (config.type) {
    case "local": return storageDriverFactories.local(config);
    case "s3": return storageDriverFactories.s3(config);
  }
}
