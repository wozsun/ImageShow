import { createWriteStream } from "node:fs";
import { link, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { runtimePaths } from "../../config/bootstrap-env.ts";
import { ApiError } from "../../core/api-error.ts";
import { mapWithWorkerPool } from "../../core/concurrency.ts";
import { pool } from "../../core/db.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { nodeReadableFromWeb } from "../../storage/stream-buffer.ts";
import { tryWithImportSessionLock } from "./session-lock.ts";

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const uuidOnlyPattern = new RegExp(`^${uuidPattern}$`, "i");
const rawImportFilePattern = new RegExp(
  `^(${uuidPattern})\\.raw\\.${uuidPattern}(?:\\.part)?$`,
  "i"
);

async function statIfExists(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function rawImportBasePath(id: string) {
  const root = runtimePaths.tempDirectory;
  const path = normalize(join(root, `${id}.raw`));
  if (!path.startsWith(`${root}${sep}`)) throw new ApiError(400, "unsafe_path", "Unsafe temporary path");
  return path;
}

export function rawImportPartPath(id: string, executionToken: string) {
  return `${rawImportAttemptPath(id, executionToken)}.part`;
}

export function rawImportAttemptPath(id: string, executionToken: string) {
  const target = rawImportBasePath(id);
  if (!uuidOnlyPattern.test(executionToken)) {
    throw new ApiError(400, "unsafe_path", "Unsafe temporary path");
  }
  return `${target}.${executionToken}`;
}

export async function publishRawImportPart(
  part: string,
  target: string,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  try {
    // Both paths are in the same temp directory. Each execution token owns a
    // unique complete key, so a hard link publishes atomically without any
    // cross-executor first-wins ambiguity.
    await link(part, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await statIfExists(target);
    if (!existing?.isFile()) throw error;
  }
  await rm(part, { force: true }).catch(() => undefined);
  return target;
}

export async function writeRawImport(
  id: string,
  body: ReadableStream<Uint8Array>,
  expectedSize: number,
  executionToken: string,
  signal?: AbortSignal
) {
  const target = rawImportAttemptPath(id, executionToken);
  const part = rawImportPartPath(id, executionToken);
  await mkdir(dirname(target), { recursive: true });
  let total = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > expectedSize) throw new ApiError(400, "upload_too_large", "图片大小超过限制");
      controller.enqueue(chunk);
    }
  });
  try {
    const readable = nodeReadableFromWeb(body.pipeThrough(limiter));
    const writable = createWriteStream(part);
    if (signal) {
      await pipeline(readable, writable, { signal });
    } else {
      await pipeline(readable, writable);
    }
    if (total !== expectedSize) {
      throw new ApiError(400, "size_mismatch", "Upload size mismatch", { expected: expectedSize, actual: total });
    }
    return await publishRawImportPart(part, target, signal);
  } catch (error) {
    // This attempt owns both names because execution tokens never share them.
    await rm(part, { force: true });
    throw error;
  }
}

export async function removeRawImportAttempt(
  id: string,
  executionToken: string
) {
  const results = await Promise.allSettled([
    rm(rawImportAttemptPath(id, executionToken), { force: true }),
    rm(rawImportPartPath(id, executionToken), { force: true })
  ]);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length) {
    throw new AggregateError(failures, "Import raw attempt cleanup failed");
  }
}

function appendRawCleanupFailure(
  failures: Map<string, unknown[]>,
  id: string,
  error: unknown
) {
  const current = failures.get(id);
  if (current) current.push(error);
  else failures.set(id, [error]);
}

export async function removeRawImports(ids: readonly string[]) {
  const targets = new Set(ids);
  const failures = new Map<string, unknown[]>();
  if (!targets.size) return failures;

  const root = runtimePaths.tempDirectory;
  const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const entries = names.flatMap((name) => {
    const match = rawImportFilePattern.exec(name);
    const id = match?.[1] ?? "";
    return targets.has(id) ? [{ id, path: join(root, name) }] : [];
  });
  await mapWithWorkerPool(
    entries,
    getRuntimeConfig().background_job.move_cleanup_concurrency,
    async ({ id, path }) => {
      try {
        await rm(path, { force: true });
      } catch (error) {
        appendRawCleanupFailure(failures, id, error);
      }
    }
  );
  return failures;
}

export async function removeRawImport(id: string) {
  const failures = await removeRawImports([id]);
  const reasons = failures.get(id) ?? [];
  if (reasons.length) {
    throw new AggregateError(reasons, "Import raw cleanup failed");
  }
}

export async function rawImportExists(id: string, executionToken: string) {
  const info = await statIfExists(rawImportAttemptPath(id, executionToken));
  return Boolean(info?.isFile());
}

export async function cleanupOrphanRawImports(maxAgeMs: number) {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  const root = runtimePaths.tempDirectory;
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = rawImportFilePattern.exec(entry.name);
    if (!match) continue;
    const id = match[1];
    const path = join(root, entry.name);
    const info = await statIfExists(path);
    if (!info || info.mtimeMs >= cutoff) continue;

    const attempt = await tryWithImportSessionLock(id, async (signal) => {
      signal.throwIfAborted();
      const referenced = await pool.query(
        "SELECT 1 FROM import_session WHERE id=$1",
        [id]
      );
      if (referenced.rowCount) return false;

      // Recheck age after taking the lifecycle lock so a newly replaced file
      // cannot be removed using stale directory metadata.
      const current = await statIfExists(path);
      if (!current || current.mtimeMs >= cutoff) return false;
      signal.throwIfAborted();
      await rm(path, { force: true });
      return true;
    });
    if (attempt.acquired && attempt.value) removed += 1;
  }
  return removed;
}
