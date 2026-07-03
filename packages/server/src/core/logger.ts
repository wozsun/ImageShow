import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { env, getRuntimeConfig } from "../config/env.js";

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, OFF: 100 } as const;
type LevelName = keyof typeof LEVELS;

const logPath = join(env.LOG_DIR, "app.log");
let logDirReady = false;

let currentLogBytes = 0;

function ensureLogDir() {
  if (logDirReady) return;
  mkdirSync(env.LOG_DIR, { recursive: true });
  try {
    currentLogBytes = statSync(logPath).size;
  } catch {
    currentLogBytes = 0;
  }
  logDirReady = true;
}

function rotateIfNeeded(maxBytes: number, maxFiles: number) {
  if (currentLogBytes < maxBytes) return;
  try {
    const oldest = `${logPath}.${maxFiles}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const source = `${logPath}.${index}`;
      if (existsSync(source)) renameSync(source, `${logPath}.${index + 1}`);
    }
    renameSync(logPath, `${logPath}.1`);
    currentLogBytes = 0;
  } catch {
    // 轮转失败时继续追加到当前日志文件。
  }
}

function formatContext(context: unknown): string {
  if (context === undefined || context === null) return "";
  if (context instanceof Error) return ` ${context.stack ?? `${context.name}: ${context.message}`}`;
  if (typeof context === "string") return ` ${context}`;
  try {
    return ` ${JSON.stringify(context)}`;
  } catch {
    return ` ${String(context)}`;
  }
}

function write(level: LevelName, message: string, context?: unknown) {
  const config = getRuntimeConfig().log;
  const threshold = LEVELS[config.level as LevelName] ?? LEVELS.WARN;
  if (LEVELS[level] < threshold) return;

  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  const line = `[${timestamp}] ${`[${level}]`.padEnd(7)} ${message}${formatContext(context)}\n`;
  (level === "ERROR" || level === "WARN" ? process.stderr : process.stdout).write(line);
  try {
    ensureLogDir();
    rotateIfNeeded(config.max_size_mb * 1024 * 1024, config.max_files);
    appendFileSync(logPath, line);
    currentLogBytes += Buffer.byteLength(line);
  } catch {
    // 控制台已输出日志，文件写入失败不向外抛出。
  }
}

export const logger = {
  debug: (message: string, context?: unknown) => write("DEBUG", message, context),
  info: (message: string, context?: unknown) => write("INFO", message, context),
  warn: (message: string, context?: unknown) => write("WARN", message, context),
  error: (message: string, context?: unknown) => write("ERROR", message, context)
};
