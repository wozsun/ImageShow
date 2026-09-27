import { AsyncLocalStorage } from "node:async_hooks";
import { hash } from "node:crypto";
import type { RuntimeConfig } from "@imageshow/shared/browser";
import { runtimeConfigFromEnvironment, runtimePaths } from "./bootstrap-env.ts";
import {
  readRuntimeConfigFile,
  RuntimeConfigPublicationError,
  writeRuntimeConfigFile
} from "./runtime-config-file.ts";
import {
  mergeRuntimeConfig,
  type RuntimeConfigPatch
} from "./runtime-config.ts";
import { logger } from "../core/logger.ts";
import { ApiError } from "../core/api-error.ts";

let runtimeConfig: RuntimeConfig | undefined;
let publicationUncertain = false;
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

export function runtimeConfigRevision(config: RuntimeConfig = getRuntimeConfig()) {
  return hash("sha256", JSON.stringify(config), "base64url");
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
        error: error
      });
    }
    listenerIndex += 1;
  }
}

/** Serialize config writers and storage Host changes against one current snapshot. */
export async function withRuntimeConfigWriteLease<T>(work: () => T | Promise<T>): Promise<T> {
  if (runtimeConfigWriteLeaseContext.getStore()) return await work();

  const predecessor = runtimeConfigWriteLeaseTail;
  const { promise, resolve: release } = Promise.withResolvers<void>();
  runtimeConfigWriteLeaseTail = promise;
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
  shouldWriteFile = true,
  reconcilePublication = false
) {
  if (publicationUncertain && !reconcilePublication) {
    throw new ApiError(409, "config_publication_uncertain",
      "上次配置文件替换后的持久化结果尚未确认，当前运行配置未切换。请检查磁盘后读取配置文件核对。");
  }
  try {
    if (shouldWriteFile) writeRuntimeConfigFile(next);
  } catch (error) {
    if (!(error instanceof RuntimeConfigPublicationError)) throw error;
    publicationUncertain = true;
    logger.error("runtime_config_publication_uncertain", { file_state: error.fileState, error });
    throw new ApiError(500, "config_publication_uncertain",
      "配置文件已替换，但持久化确认失败，当前运行配置未切换。草稿已保留，请检查磁盘后读取配置文件核对。",
      { file_state: error.fileState });
  }
  publicationUncertain = false;
  return publishRuntimeConfig(next);
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

export function reloadRuntimeConfigFromDisk(validate?: (config: RuntimeConfig) => Promise<void>) {
  return withRuntimeConfigWriteLease(async () => {
    getRuntimeConfig();
    const snapshot = readRuntimeConfigFile();
    if (!snapshot) {
      throw new Error(`Runtime config ${runtimePaths.configFile} does not exist`);
    }
    await validate?.(snapshot.config);
    return persistAndPublishRuntimeConfig(
      snapshot.config,
      snapshot.needsWriteBack || publicationUncertain,
      true
    );
  });
}
