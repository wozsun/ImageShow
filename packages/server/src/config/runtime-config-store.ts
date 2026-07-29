import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeConfig } from "@imageshow/shared";
import { runtimeConfigFromEnvironment, runtimePaths } from "./bootstrap-env.ts";
import {
  readRuntimeConfigFile,
  writeRuntimeConfigFile
} from "./runtime-config-file.ts";
import {
  mergeRuntimeConfig,
  type RuntimeConfigPatch
} from "./runtime-config.ts";

let runtimeConfig: RuntimeConfig | undefined;
let runtimeConfigRevision = 0;
const runtimeConfigWriteLeaseContext = new AsyncLocalStorage<boolean>();
let runtimeConfigWriteLeaseTail = Promise.resolve();

export function initializeRuntimeConfig() {
  if (runtimeConfig) return runtimeConfig;

  const existing = readRuntimeConfigFile();
  const initial = existing?.config ?? runtimeConfigFromEnvironment();
  if (!existing || existing.needsWriteBack) writeRuntimeConfigFile(initial);
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
const runtimeConfigListeners: RuntimeConfigListener[] = [];

export function onRuntimeConfigChange(listener: RuntimeConfigListener) {
  runtimeConfigListeners.push(listener);
}

function notifyRuntimeConfigChange() {
  for (const listener of runtimeConfigListeners) listener();
}

/** Serialize every in-process writer, including a config import's compensation window. */
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

function commitRuntimeConfig(next: RuntimeConfig) {
  getRuntimeConfig();
  writeRuntimeConfigFile(next);
  runtimeConfig = next;
  runtimeConfigRevision += 1;
  const revision = runtimeConfigRevision;
  notifyRuntimeConfigChange();
  return { config: next, revision };
}

export function updateRuntimeConfig(patch: RuntimeConfigPatch) {
  return withRuntimeConfigWriteLease(() => {
    const next = mergeRuntimeConfig(getRuntimeConfig(), patch);
    return commitRuntimeConfig(next).config;
  });
}

/** Apply a patch and return the exact in-process write revision for rollback fencing. */
export function updateRuntimeConfigWithRevision(patch: RuntimeConfigPatch) {
  return withRuntimeConfigWriteLease(() => {
    const next = mergeRuntimeConfig(getRuntimeConfig(), patch);
    return commitRuntimeConfig(next);
  });
}

export function replaceRuntimeConfig(next: RuntimeConfig) {
  return withRuntimeConfigWriteLease(() => commitRuntimeConfig(next).config);
}

/** Replace an earlier write only if its exact revision is still current. */
export function replaceRuntimeConfigIfRevision(
  expectedRevision: number,
  next: RuntimeConfig
) {
  return withRuntimeConfigWriteLease(() => {
    getRuntimeConfig();
    if (runtimeConfigRevision !== expectedRevision) return false;
    commitRuntimeConfig(next);
    return true;
  });
}

export function reloadRuntimeConfig() {
  return withRuntimeConfigWriteLease(() => {
    getRuntimeConfig();
    const snapshot = readRuntimeConfigFile();
    if (!snapshot) {
      throw new Error(`Runtime config ${runtimePaths.configFile} does not exist`);
    }
    if (snapshot.needsWriteBack) writeRuntimeConfigFile(snapshot.config);
    runtimeConfig = snapshot.config;
    runtimeConfigRevision += 1;
    notifyRuntimeConfigChange();
    return runtimeConfig;
  });
}
