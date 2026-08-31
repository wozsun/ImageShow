import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import type { RuntimeConfig } from "@imageshow/shared/browser";
import { runtimePaths } from "./bootstrap-env.ts";
import { normalizeRuntimeConfig } from "./runtime-config.ts";
import {
  legacyWeiboAuthorSlugsFromRuntimeConfig,
  type LegacyWeiboAuthorSlugs
} from "./legacy-weibo-author-slugs-config.ts";

export type RuntimeConfigFileSnapshot = {
  config: RuntimeConfig;
  needsWriteBack: boolean;
};

type RuntimeConfigFileSource = RuntimeConfigFileSnapshot & {
  value: unknown;
};

function readRuntimeConfigFileSource(): RuntimeConfigFileSource | null {
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
  return {
    config: normalized,
    needsWriteBack: JSON.stringify(value) !== JSON.stringify(normalized),
    value
  };
}

export function readRuntimeConfigFile(): RuntimeConfigFileSnapshot | null {
  const source = readRuntimeConfigFileSource();
  if (!source) return null;
  return { config: source.config, needsWriteBack: source.needsWriteBack };
}

export type LegacyWeiboAuthorSlugsRuntimeConfigFileSnapshot =
  RuntimeConfigFileSnapshot & {
    legacyWeiboAuthorSlugs: LegacyWeiboAuthorSlugs | undefined;
  };

/** Isolated startup-only reader for the 5.4.0 weibo.author_slugs upgrade. */
export function readRuntimeConfigFileForLegacyWeiboAuthorSlugsUpgrade():
  LegacyWeiboAuthorSlugsRuntimeConfigFileSnapshot | null {
  const source = readRuntimeConfigFileSource();
  if (!source) return null;
  return {
    config: source.config,
    needsWriteBack: source.needsWriteBack,
    legacyWeiboAuthorSlugs:
      legacyWeiboAuthorSlugsFromRuntimeConfig(source.value)
  };
}

export function writeRuntimeConfigFile(value: RuntimeConfig) {
  mkdirSync(runtimePaths.configDirectory, { recursive: true });
  const temporaryPath =
    `${runtimePaths.configFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const temporaryFile = openSync(temporaryPath, "wx", 0o600);
    try {
      writeFileSync(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fsyncSync(temporaryFile);
    } finally {
      closeSync(temporaryFile);
    }
    renameSync(temporaryPath, runtimePaths.configFile);
    syncRuntimeConfigDirectory();
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function syncRuntimeConfigDirectory() {
  // Node cannot open directory handles on Windows. The production container is
  // Linux, where syncing the parent makes the rename durable as well as atomic.
  if (process.platform === "win32") return;
  const directory = openSync(runtimePaths.configDirectory, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
