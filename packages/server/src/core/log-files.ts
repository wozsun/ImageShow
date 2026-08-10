import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  logLevels,
  type AdminLogLevelDto,
  type AdminLogPayloadDto,
  type LogFileSummaryDto,
  type LogLevel
} from "@imageshow/shared/browser";
import { runtimePaths } from "../config/bootstrap-env.ts";
import {
  getRuntimeConfig,
  updateRuntimeConfig,
  withRuntimeConfigWriteLease
} from "../config/runtime-config-store.ts";
import { ApiError } from "./api-error.ts";

const logFilePattern = /^app\.log(?:\.\d+)?$/;
const defaultTailBytes = 200_000;
const maxTailBytes = 1_000_000;

function isMissingLogFile(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

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

async function listLogFiles(): Promise<LogFileSummaryDto[]> {
  let names: string[];
  try {
    names = await readdir(runtimePaths.logDirectory);
  } catch (error) {
    if (isMissingLogFile(error)) return [];
    throw error;
  }
  const files = await Promise.all(names
    .filter((name) => logFilePattern.test(name))
    .sort((a, b) => logFileSortKey(a) - logFileSortKey(b))
    .map(async (name) => {
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(join(runtimePaths.logDirectory, name));
      } catch (error) {
        if (isMissingLogFile(error)) return null;
        throw error;
      }
      if (!info?.isFile()) return null;
      return { name, size: info.size, modified_at: info.mtime.toISOString() };
    }));
  return files.filter((file): file is LogFileSummaryDto => file !== null);
}

async function tailFile(name: string, limitBytes: number) {
  const safeName = basename(name);
  if (!logFilePattern.test(safeName)) throw new ApiError(400, "invalid_log_file", "日志文件名无效");
  const path = join(runtimePaths.logDirectory, safeName);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isMissingLogFile(error)) {
      return { content: "", truncated: false, bytes_read: 0 };
    }
    throw error;
  }
  try {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await handle.stat();
    } catch (error) {
      if (isMissingLogFile(error)) {
        return { content: "", truncated: false, bytes_read: 0 };
      }
      throw error;
    }
    if (!info.isFile()) {
      return { content: "", truncated: false, bytes_read: 0 };
    }
    const start = Math.max(0, info.size - limitBytes);
    const size = info.size - start;
    const buffer = Buffer.allocUnsafe(size);
    let bytesRead = 0;
    while (bytesRead < size) {
      let result: { bytesRead: number };
      try {
        result = await handle.read(
          buffer,
          bytesRead,
          size - bytesRead,
          start + bytesRead
        );
      } catch (error) {
        if (isMissingLogFile(error)) break;
        throw error;
      }
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    return {
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      truncated: start > 0,
      bytes_read: bytesRead
    };
  } finally {
    await handle.close();
  }
}

export async function readRecentLogFile(
  input: { file?: string | null; limit?: string | null }
): Promise<AdminLogPayloadDto> {
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

export async function updateLogLevel(level: string): Promise<AdminLogLevelDto> {
  if (!logLevels.includes(level as LogLevel)) {
    throw new ApiError(400, "invalid_log_level", "日志等级无效");
  }
  return withRuntimeConfigWriteLease(async () => {
    await updateRuntimeConfig({ log: { ...getRuntimeConfig().log, level: level as LogLevel } });
    return { level: getRuntimeConfig().log.level };
  });
}
