// Minimal site-wide logger. One line per entry — "<timestamp> <LEVEL> <message> <context?>" —
// written to stdout/stderr (so `docker logs` shows it) and appended to a rotating file under
// data/log/app.log. The threshold level and rotation bounds are runtime config (config.json
// log.*), read per call so a settings reload applies live. Logging never throws: a logging
// failure (full disk, permissions) must not break the request that triggered it.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { env, getRuntimeConfig } from "../config/env.js";

// Numeric severities; a message is emitted only when its level is >= the configured threshold.
// OFF (100) sits above every real level, so selecting it silences everything.
const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, OFF: 100 } as const;
type LevelName = keyof typeof LEVELS;

const logPath = join(env.LOG_DIR, "app.log");
let logDirReady = false;
// Current size of app.log, tracked in memory so rotation doesn't statSync on every line.
// Seeded once from the on-disk file (to account for bytes written before this process
// started), then bumped per append and reset to 0 on rotation.
let currentLogBytes = 0;

function ensureLogDir() {
  if (logDirReady) return;
  mkdirSync(env.LOG_DIR, { recursive: true });
  try {
    currentLogBytes = statSync(logPath).size;
  } catch {
    currentLogBytes = 0; // no log file yet
  }
  logDirReady = true;
}

// Size-based rotation: once app.log passes max_size_mb, drop the oldest archive, shift
// app.log.(N-1) → app.log.N … app.log.1 → app.log.2, then app.log → app.log.1, leaving a fresh
// app.log for the next append. Keeps any single file bounded by max_size_mb. Driven by the
// in-memory byte counter (no per-line stat); the counter resets once the file is rolled away.
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
    // A failed rotation just means the next write keeps appending to the current file.
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
  // e.g. "[2026-06-29 12:34:56.789] [WARN]  storage backend unreachable {"slug":"cos"}"
  // The bracketed level is padded to the widest tag ([DEBUG]/[ERROR] = 7) so messages align.
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  const line = `[${timestamp}] ${`[${level}]`.padEnd(7)} ${message}${formatContext(context)}\n`;
  (level === "ERROR" || level === "WARN" ? process.stderr : process.stdout).write(line);
  try {
    ensureLogDir();
    rotateIfNeeded(config.max_size_mb * 1024 * 1024, config.max_files);
    appendFileSync(logPath, line);
    currentLogBytes += Buffer.byteLength(line);
  } catch {
    // Console already carried the line; a file failure must not propagate.
  }
}

export const logger = {
  debug: (message: string, context?: unknown) => write("DEBUG", message, context),
  info: (message: string, context?: unknown) => write("INFO", message, context),
  warn: (message: string, context?: unknown) => write("WARN", message, context),
  error: (message: string, context?: unknown) => write("ERROR", message, context)
};
