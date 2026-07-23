import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeConfig } from "@imageshow/shared";
import { runtimeConfigFromEnvironment, runtimePaths } from "./bootstrap-env.ts";
import {
  mergeRuntimeConfig,
  parseRuntimeConfig,
  type RuntimeConfigPatch
} from "./runtime-config.ts";

function readRuntimeConfigFile(): RuntimeConfig | null {
  if (!existsSync(runtimePaths.configFile)) return null;

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(runtimePaths.configFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot parse runtime config ${runtimePaths.configFile}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let parsed: RuntimeConfig;
  try {
    parsed = parseRuntimeConfig(value);
  } catch (error) {
    throw new Error(
      `Invalid runtime config ${runtimePaths.configFile}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return parsed;
}

function writeRuntimeConfigFile(value: RuntimeConfig) {
  mkdirSync(runtimePaths.configDirectory, { recursive: true });
  const temporaryPath = `${runtimePaths.configFile}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, runtimePaths.configFile);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

const existingRuntimeConfig = readRuntimeConfigFile();
let runtimeConfig = existingRuntimeConfig ?? runtimeConfigFromEnvironment();
if (!existingRuntimeConfig) writeRuntimeConfigFile(runtimeConfig);
let runtimeConfigRevision = 0;
const runtimeConfigWriteLeaseContext = new AsyncLocalStorage<boolean>();
let runtimeConfigWriteLeaseTail = Promise.resolve();

export function getRuntimeConfig() {
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
  writeRuntimeConfigFile(next);
  runtimeConfig = next;
  runtimeConfigRevision += 1;
  const revision = runtimeConfigRevision;
  notifyRuntimeConfigChange();
  return { config: next, revision };
}

export function updateRuntimeConfig(patch: RuntimeConfigPatch) {
  return withRuntimeConfigWriteLease(() => {
    const next = mergeRuntimeConfig(runtimeConfig, patch);
    return commitRuntimeConfig(next).config;
  });
}

/** Apply a patch and return the exact in-process write revision for rollback fencing. */
export function updateRuntimeConfigWithRevision(patch: RuntimeConfigPatch) {
  return withRuntimeConfigWriteLease(() => {
    const next = mergeRuntimeConfig(runtimeConfig, patch);
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
    if (runtimeConfigRevision !== expectedRevision) return false;
    commitRuntimeConfig(next);
    return true;
  });
}

export function reloadRuntimeConfig() {
  return withRuntimeConfigWriteLease(() => {
    const fromDisk = readRuntimeConfigFile();
    if (!fromDisk) throw new Error(`Runtime config ${runtimePaths.configFile} does not exist`);
    runtimeConfig = fromDisk;
    runtimeConfigRevision += 1;
    notifyRuntimeConfigChange();
    return runtimeConfig;
  });
}

export type { RuntimeConfig } from "@imageshow/shared";
