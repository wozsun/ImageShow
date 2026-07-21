import { ApiError } from "../core/api-error.ts";
import type { StorageConfig } from "./backend-config.ts";
import type { StorageDriver } from "./storage-backend.ts";
import type { StoragePrefix } from "./object-keys.ts";
import { shareStorageNamespace } from "./storage-namespace.ts";

type StorageEndpoint = {
  config: StorageConfig;
  driver: StorageDriver;
};

export type VerifiedObjectTransfer = {
  created: boolean;
  sharedNamespace: boolean;
};

function objectConflict(
  source: StorageEndpoint,
  target: StorageEndpoint,
  prefix: StoragePrefix,
  key: string
) {
  return new ApiError(
    409,
    "storage_object_conflict",
    "目标存储中已存在内容不一致的同名对象",
    {
      prefix,
      key,
      source: source.config.slug,
      target: target.config.slug
    }
  );
}

/**
 * Materialize one already-read source object at the destination and verify the
 * exact bytes before the caller changes database ownership. An equivalent
 * namespace is a metadata-only switch after the target credentials have read
 * and verified the shared object: writing the target would overwrite the
 * source object and later cleanup could delete the live object.
 */
export async function ensureVerifiedObjectAtDestination(input: {
  source: StorageEndpoint;
  target: StorageEndpoint;
  prefix: StoragePrefix;
  key: string;
  body: Buffer;
  contentType: string;
  sourceObjectExists?: boolean;
}): Promise<VerifiedObjectTransfer> {
  const { source, target, prefix, key, body, contentType } = input;
  const sharedNamespace = shareStorageNamespace(source.config, target.config);
  if (sharedNamespace && input.sourceObjectExists !== false) {
    if (!await target.driver.exists(prefix, key)) {
      throw new ApiError(
        502,
        "storage_shared_object_unavailable",
        "目标后端无法访问共享命名空间中的源对象",
        {
          prefix,
          key,
          source: source.config.slug,
          target: target.config.slug
        }
      );
    }
    const existing = await target.driver.readBuffer(prefix, key);
    if (!existing.equals(body)) {
      throw objectConflict(source, target, prefix, key);
    }
    return { created: false, sharedNamespace: true };
  }

  if (await target.driver.exists(prefix, key)) {
    const existing = await target.driver.readBuffer(prefix, key);
    if (!existing.equals(body)) {
      throw objectConflict(source, target, prefix, key);
    }
    return { created: false, sharedNamespace };
  }

  let writeCompleted = false;
  try {
    await target.driver.writeBuffer(prefix, key, body, contentType);
    writeCompleted = true;
    const stored = await target.driver.readBuffer(prefix, key);
    if (!stored.equals(body)) {
      throw new ApiError(
        502,
        "storage_transfer_integrity_failed",
        "目标存储写入后的对象完整性校验失败",
        { prefix, key, target: target.config.slug }
      );
    }
    return { created: true, sharedNamespace };
  } catch (error) {
    if (writeCompleted) {
      await target.driver.remove(prefix, key).catch(() => undefined);
    }
    throw error;
  }
}
