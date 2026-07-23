import { ApiError, errorMessage } from "../core/api-error.ts";
import { logger } from "../core/logger.ts";
import {
  defaultS3Settings,
  defaultWebdavSettings,
  s3SettingsSchema,
  webdavSettingsSchema,
  type StorageConfig
} from "./backend-config.ts";
import {
  withStoredS3Credential,
  withStoredWebdavCredential
} from "./backend-record.ts";
import {
  getStorageBackend,
  resolveStorageAccessForConfig
} from "./backend-registry.ts";
import type { StorageDriver } from "./driver.ts";
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
  existingObject: ExistingStorageProbe
) {
  try {
    const opened = await driver.openRead(
      "media",
      existingObject.object_key,
      "bytes=0-0"
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
  }
) {
  const testConfig = { ...config, slug: "(test)" };
  const driver = resolveStorageAccessForConfig(testConfig).driver;
  try {
    if (existingObject) {
      await assertExistingObjectReadable(driver, existingObject);
    }
    if (endpointRebind) {
      await verifyStorageEndpointRebind({
        current: resolveStorageAccessForConfig(
          endpointRebind.currentConfig
        ).driver,
        candidate: driver,
        currentStaging: endpointRebind.currentStaging
      });
      return;
    }
    const result = await driver.selfTest();
    if (!result.writable) {
      throw new ApiError(
        502,
        "storage_test_failed",
        "Storage backend did not confirm write access"
      );
    }
  } finally {
    await Promise.resolve().then(() => driver.close?.()).catch((error) => {
      logger.warn("storage_probe_driver_close_failed", {
        backend: config.slug,
        error: errorMessage(error)
      });
    });
  }
}

export async function resolveStorageTestConfig(input: {
  slug?: string;
  type?: string;
  s3?: unknown;
  webdav?: unknown;
}): Promise<StorageConfig> {
  const current = input.slug
    ? await getStorageBackend(input.slug)
    : undefined;
  if (current?.type === "local") return current;

  const type = current?.type
    ?? (input.type === "webdav" || input.webdav ? "webdav" : "s3");
  if (type === "webdav") {
    const candidate = webdavSettingsSchema.parse(
      input.webdav ?? current?.webdav ?? {}
    );
    return {
      slug: "(test)",
      type: "webdav",
      s3: defaultS3Settings,
      webdav: withStoredWebdavCredential(
        candidate,
        current?.type === "webdav" ? current.webdav : undefined
      )
    };
  }

  const candidate = s3SettingsSchema.parse(
    input.s3 ?? current?.s3 ?? {}
  );
  return {
    slug: "(test)",
    type: "s3",
    s3: withStoredS3Credential(
      candidate,
      current?.type === "s3" ? current.s3 : undefined
    ),
    webdav: defaultWebdavSettings
  };
}
