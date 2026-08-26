import { errorMessage } from "../../core/api-error.ts";
import { logger } from "../../core/logger.ts";
import type { StorageConfig } from "./config.ts";
import {
  resolveStorageAccess,
  resolveStorageAccessForConfig
} from "./registry.ts";

export async function testStorageBackend(
  config?: StorageConfig,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const access = config
    ? resolveStorageAccessForConfig(config)
    : await resolveStorageAccess();
  const { config: effective, driver } = access;
  try {
    await driver.selfTest({ signal });
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
