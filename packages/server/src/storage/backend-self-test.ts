import type { StorageConfig } from "./backend-config.ts";
import {
  getDefaultStorageBackend,
  resolveStorageAccessForConfig
} from "./backend-registry.ts";

export async function testStorageBackend(config?: StorageConfig) {
  const effective = config ?? await getDefaultStorageBackend();
  const driver = resolveStorageAccessForConfig(effective).driver;
  try {
    return await driver.selfTest();
  } finally {
    if (effective.slug === "(test)") {
      await Promise.resolve(driver.close?.()).catch(() => undefined);
    }
  }
}
