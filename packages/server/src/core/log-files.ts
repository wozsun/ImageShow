import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { runtimePaths } from "../config/bootstrap-env.ts";
import { getRuntimeConfig, updateRuntimeConfig } from "../config/runtime-config-store.ts";
import { ApiError } from "./api-error.ts";

const logFilePattern = /^app\.log(?:\.\d+)?$/;
const defaultTailBytes = 200_000;
const maxTailBytes = 1_000_000;
const logLevels = ["DEBUG", "INFO", "WARN", "ERROR", "OFF"] as const;

type LogLevel = (typeof logLevels)[number];

export type LogFileSummary = {
  name: string;
  size: number;
  modified_at: string;
};

function normalizeLimit(value: string | null) {
  const parsed = Number(value ?? defaultTailBytes);
  if (!Number.isFinite(parsed)) return defaultTailBytes;
  return Math.min(maxTailBytes, Math.max(1_000, Math.floor(parsed)));
}

function logFileSortKey(name: string) {
  if (name === "app.log") return 0;
  const index = Number(name.replace("app.log.", ""));
  return Number.isFinite(index) ? index : Number.MAX_SAFE_INTEGER;
}

async function listLogFiles(): Promise<LogFileSummary[]> {
  const names = await readdir(runtimePaths.logDirectory).catch(() => []);
  const files = await Promise.all(names
    .filter((name) => logFilePattern.test(name))
    .sort((a, b) => logFileSortKey(a) - logFileSortKey(b))
    .map(async (name) => {
      const info = await stat(join(runtimePaths.logDirectory, name)).catch(() => null);
      if (!info?.isFile()) return null;
      return { name, size: info.size, modified_at: info.mtime.toISOString() };
    }));
  return files.filter((file): file is LogFileSummary => file !== null);
}

async function tailFile(name: string, limitBytes: number) {
  const safeName = basename(name);
  if (!logFilePattern.test(safeName)) throw new ApiError(400, "invalid_log_file", "日志文件名无效");
  const path = join(runtimePaths.logDirectory, safeName);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return { content: "", truncated: false, bytes_read: 0 };

  const start = Math.max(0, info.size - limitBytes);
  const size = info.size - start;
  const buffer = Buffer.alloc(size);
  const handle = await open(path, "r");
  try {
    await handle.read(buffer, 0, size, start);
  } finally {
    await handle.close();
  }
  return { content: buffer.toString("utf8"), truncated: start > 0, bytes_read: size };
}

export async function readRecentLogFile(input: { file?: string | null; limit?: string | null }) {
  const files = await listLogFiles();
  const selected = input.file && logFilePattern.test(input.file) ? input.file : files[0]?.name ?? "app.log";
  const limitBytes = normalizeLimit(input.limit ?? null);
  const tail = await tailFile(selected, limitBytes);
  return {
    level: getRuntimeConfig().log.level,
    files,
    selected,
    limit_bytes: limitBytes,
    ...tail
  };
}

export function updateLogLevel(level: string) {
  if (!logLevels.includes(level as LogLevel)) {
    throw new ApiError(400, "invalid_log_level", "日志等级无效");
  }
  updateRuntimeConfig({ log: { ...getRuntimeConfig().log, level: level as LogLevel } });
  return { level: getRuntimeConfig().log.level };
}
