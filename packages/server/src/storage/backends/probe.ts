import { ApiError, errorMessage } from "../../core/api-error.ts";
import { logger } from "../../core/logger.ts";
import {
  mergeS3Settings,
  type StorageBackendTestInput,
  type StorageConfig
} from "./config.ts";
import {
  getStorageBackend,
  resolveStorageAccessForConfig
} from "./registry.ts";
import type { StorageDriver } from "../drivers/driver.ts";
import { assertCanonicalImageObjectKey } from "../objects/image-paths.ts";
import {
  verifyStorageEndpointRebind,
  type StagingNamespaceSnapshot
} from "./endpoint-rebind.ts";

export type ExistingStorageProbe = {
  id: string;
  object_key: string;
  storage_slug: string;
};

async function assertExistingObjectReadable(
  driver: StorageDriver,
  existingObject: ExistingStorageProbe,
  signal?: AbortSignal
) {
  try {
    assertCanonicalImageObjectKey(existingObject.object_key);
    const opened = await driver.openRead(
      "full",
      existingObject.object_key,
      "bytes=0-0",
      { signal }
    );
    let received = false;
    try {
      for await (const chunk of opened.body) {
        if (Buffer.byteLength(chunk) > 0) {
          received = true;
          break;
        }
      }
    } finally {
      opened.body.destroy();
    }
    if (received) return;
    throw new Error("Storage returned an empty object probe");
  } catch (error) {
    signal?.throwIfAborted();
    throw new ApiError(
      502,
      "storage_access_probe_failed",
      "Storage backend could not read an existing referenced object",
      {
        image_id: existingObject.id,
        reason: errorMessage(error)
      }
    );
  }
}

export async function validateStorageBackendCandidate(
  config: StorageConfig,
  existingObject?: ExistingStorageProbe,
  endpointRebind?: {
    currentConfig: StorageConfig;
    currentStaging: StagingNamespaceSnapshot;
  },
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const testConfig = { ...config, slug: "(test)" };
  const driver = resolveStorageAccessForConfig(testConfig).driver;
  try {
    if (existingObject) {
      await assertExistingObjectReadable(driver, existingObject, signal);
    }
    if (endpointRebind) {
      await verifyStorageEndpointRebind({
        current: resolveStorageAccessForConfig(
          endpointRebind.currentConfig
        ).driver,
        candidate: driver,
        currentStaging: endpointRebind.currentStaging,
        signal
      });
      return;
    }
    const result = await driver.selfTest({ signal });
    if (!result.writable) {
      throw new ApiError(
        502,
        "storage_test_failed",
        "Storage backend did not confirm write access"
      );
    }
    signal?.throwIfAborted();
  } finally {
    await Promise.resolve().then(() => driver.close?.()).catch((error) => {
      logger.warn("storage_probe_driver_close_failed", {
        backend: config.slug,
        error: errorMessage(error)
      });
    });
  }
}

export async function resolveStorageTestConfig(
  input: StorageBackendTestInput
): Promise<StorageConfig> {
  const current = input.slug
    ? await getStorageBackend(input.slug)
    : undefined;
  if (current?.type === "local") return current;

  const currentS3 = current?.type === "s3" ? current.s3 : undefined;
  const candidate = mergeS3Settings(input.s3, currentS3);
  return {
    slug: "(test)",
    type: "s3",
    s3: candidate
  };
}
