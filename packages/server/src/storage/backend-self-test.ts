import { errorMessage } from "../core/api-error.ts";
import { logger } from "../core/logger.ts";
import type { StorageConfig } from "./backend-config.ts";
import {
  getDefaultStorageBackend,
  resolveStorageAccessForConfig
} from "./backend-registry.ts";

export async function testStorageBackend(config?: StorageConfig) {
  const effective = config ?? await getDefaultStorageBackend();
  const driver = resolveStorageAccessForConfig(effective).driver;
  try {
    await driver.selfTest();
  } finally {
    if (effective.slug === "(test)") {
      await Promise.resolve().then(() => driver.close?.()).catch((error) => {
        logger.warn("storage_self_test_driver_close_failed", {
          error: errorMessage(error)
        });
      });
    }
  }
}
