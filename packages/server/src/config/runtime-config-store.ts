import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { RuntimeConfig } from "@imageshow/shared";
import { runtimeConfigFromEnvironment, runtimePaths } from "./bootstrap-env.ts";
import {
  mergeRuntimeConfig,
  normalizeRuntimeConfig,
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

  let normalized: RuntimeConfig;
  try {
    normalized = normalizeRuntimeConfig(value);
  } catch (error) {
    throw new Error(
      `Invalid runtime config ${runtimePaths.configFile}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (JSON.stringify(value) !== JSON.stringify(normalized)) {
    writeRuntimeConfigFile(normalized);
  }
  return normalized;
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

export function updateRuntimeConfig(patch: RuntimeConfigPatch) {
  const next = mergeRuntimeConfig(runtimeConfig, patch);
  writeRuntimeConfigFile(next);
  runtimeConfig = next;
  notifyRuntimeConfigChange();
  return runtimeConfig;
}

export function replaceRuntimeConfig(next: RuntimeConfig) {
  writeRuntimeConfigFile(next);
  runtimeConfig = next;
  notifyRuntimeConfigChange();
  return runtimeConfig;
}

export function reloadRuntimeConfig() {
  const fromDisk = readRuntimeConfigFile();
  if (!fromDisk) throw new Error(`Runtime config ${runtimePaths.configFile} does not exist`);
  runtimeConfig = fromDisk;
  notifyRuntimeConfigChange();
  return runtimeConfig;
}

export type { RuntimeConfig } from "@imageshow/shared";
