import { ApiError } from "../core/api-error.ts";
import type { StorageConfig } from "./backend-config.ts";
import type { StorageDriver } from "./storage-backend.ts";
import type { StoragePrefix } from "./object-keys.ts";
import { shareStorageNamespace } from "./storage-namespace.ts";

export type StorageEndpoint = {
  config: StorageConfig;
  driver: StorageDriver;
};

export type VerifiedObjectTransfer = {
  created: boolean;
  sharedNamespace: boolean;
};

function objectConflict(
  target: StorageEndpoint,
  prefix: StoragePrefix,
  key: string,
  sourceSlug?: string
) {
  return new ApiError(
    409,
    "storage_object_conflict",
    "正式存储对象与候选内容不一致",
    {
      prefix,
      key,
      ...(sourceSlug ? { source: sourceSlug } : {}),
      target: target.config.slug
    }
  );
}

/**
 * Materialize an already-read object at one target and verify the exact bytes.
 * Existing objects are never overwritten or removed. A candidate written by
 * this invocation is read back before ownership may move to it, and only that
 * candidate is removed if verification fails.
 */
export async function ensureVerifiedObjectAtTarget(input: {
  target: StorageEndpoint;
  prefix: StoragePrefix;
  key: string;
  body: Buffer;
  contentType: string;
  sourceSlug?: string;
}): Promise<{ created: boolean }> {
  const { target, prefix, key, body, contentType, sourceSlug } = input;
  if (await target.driver.exists(prefix, key)) {
    const existing = await target.driver.readBuffer(prefix, key);
    if (!existing.equals(body)) {
      throw objectConflict(target, prefix, key, sourceSlug);
    }
    return { created: false };
  }

  let writeCompleted = false;
  try {
    await target.driver.writeBuffer(prefix, key, body, contentType);
    writeCompleted = true;
    const stored = await target.driver.readBuffer(prefix, key);
    if (!stored.equals(body)) {
      throw objectConflict(target, prefix, key, sourceSlug);
    }
    return { created: true };
  } catch (error) {
    // Only a successfully materialized candidate is owned by this invocation.
    // A failed write is not enough evidence to remove an object at this key.
    if (writeCompleted) {
      await target.driver.remove(prefix, key).catch(() => undefined);
    }
    throw error;
  }
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
      throw objectConflict(target, prefix, key, source.config.slug);
    }
    return { created: false, sharedNamespace: true };
  }

  const result = await ensureVerifiedObjectAtTarget({
    target,
    prefix,
    key,
    body,
    contentType,
    sourceSlug: source.config.slug
  });
  return { ...result, sharedNamespace };
}
