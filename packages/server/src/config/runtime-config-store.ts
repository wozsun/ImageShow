import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeConfig } from "@imageshow/shared/browser";
import { runtimeConfigFromEnvironment, runtimePaths } from "./bootstrap-env.ts";
import {
  readRuntimeConfigFile,
  writeRuntimeConfigFile
} from "./runtime-config-file.ts";
import {
  mergeRuntimeConfig,
  type RuntimeConfigPatch
} from "./runtime-config.ts";
import { errorMessage } from "../core/api-error.ts";
import { logger } from "../core/logger.ts";

let runtimeConfig: RuntimeConfig | undefined;
const runtimeConfigWriteLeaseContext = new AsyncLocalStorage<boolean>();
let runtimeConfigWriteLeaseTail = Promise.resolve();

export function initializeRuntimeConfig() {
  if (runtimeConfig) return runtimeConfig;

  const existing = readRuntimeConfigFile();
  const initial = existing?.config ?? runtimeConfigFromEnvironment();
  if (!existing || existing.needsWriteBack) {
    writeRuntimeConfigFile(initial);
  }
  runtimeConfig = initial;
  return runtimeConfig;
}

export function getRuntimeConfig() {
  if (!runtimeConfig) {
    throw new Error(
      "Runtime config has not been initialized. Call initializeRuntimeConfig() first."
    );
  }
  return runtimeConfig;
}

type RuntimeConfigListener = () => void;
const runtimeConfigListeners = new Set<RuntimeConfigListener>();

export function onRuntimeConfigChange(listener: RuntimeConfigListener) {
  runtimeConfigListeners.add(listener);
  return () => {
    runtimeConfigListeners.delete(listener);
  };
}

function notifyRuntimeConfigChange() {
  let listenerIndex = 0;
  for (const listener of runtimeConfigListeners) {
    try {
      listener();
    } catch (error) {
      logger.error("runtime_config_listener_failed", {
        listener_index: listenerIndex,
        error: errorMessage(error)
      });
    }
    listenerIndex += 1;
  }
}

/** Serialize every writer, including a config import's persistence and settlement window. */
export async function withRuntimeConfigWriteLease<T>(
  work: () => T | Promise<T>
): Promise<T> {
  if (runtimeConfigWriteLeaseContext.getStore()) return await work();

  const predecessor = runtimeConfigWriteLeaseTail;
  let release: () => void = () => undefined;
  runtimeConfigWriteLeaseTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  try {
    return await runtimeConfigWriteLeaseContext.run(true, work);
  } finally {
    release();
  }
}

function publishRuntimeConfig(next: RuntimeConfig) {
  getRuntimeConfig();
  runtimeConfig = next;
  notifyRuntimeConfigChange();
  return next;
}

function persistAndPublishRuntimeConfig(
  next: RuntimeConfig,
  shouldWriteFile = true
) {
  if (shouldWriteFile) writeRuntimeConfigFile(next);
  return publishRuntimeConfig(next);
}

function assertRuntimeConfigWriteLeaseHeld() {
  if (!runtimeConfigWriteLeaseContext.getStore()) {
    throw new Error("Runtime config package stage requires the write lease");
  }
}

export function updateRuntimeConfig(patch: RuntimeConfigPatch) {
  return withRuntimeConfigWriteLease(() => {
    const next = mergeRuntimeConfig(getRuntimeConfig(), patch);
    return persistAndPublishRuntimeConfig(next);
  });
}

export function replaceRuntimeConfig(next: RuntimeConfig) {
  return withRuntimeConfigWriteLease(() => persistAndPublishRuntimeConfig(next));
}

/** Persist a config-package candidate or rollback snapshot without publishing. */
export function persistRuntimeConfigForPackageImport(next: RuntimeConfig) {
  assertRuntimeConfigWriteLeaseHeld();
  getRuntimeConfig();
  writeRuntimeConfigFile(next);
}

/** Publish a successfully persisted config-package candidate exactly once. */
export function publishRuntimeConfigForPackageImport(next: RuntimeConfig) {
  assertRuntimeConfigWriteLeaseHeld();
  return publishRuntimeConfig(next);
}

export function reloadRuntimeConfigFromDisk() {
  return withRuntimeConfigWriteLease(() => {
    getRuntimeConfig();
    const snapshot = readRuntimeConfigFile();
    if (!snapshot) {
      throw new Error(`Runtime config ${runtimePaths.configFile} does not exist`);
    }
    return persistAndPublishRuntimeConfig(
      snapshot.config,
      snapshot.needsWriteBack
    );
  });
}
