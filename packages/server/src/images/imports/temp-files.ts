import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { runtimePaths } from "../../config/bootstrap-env.ts";
import { ApiError } from "../../core/api-error.ts";
import { pool } from "../../core/db.ts";
import { nodeReadableFromWeb } from "../../storage/stream-buffer.ts";
import { tryWithImportSessionLock } from "./session-lock.ts";

const rawImportFilePattern = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.raw(?:\.part)?$/i;

async function statIfExists(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function rawImportPath(id: string) {
  const root = runtimePaths.tempDirectory;
  const path = normalize(join(root, `${id}.raw`));
  if (!path.startsWith(`${root}${sep}`)) throw new ApiError(400, "unsafe_path", "Unsafe temporary path");
  return path;
}

export async function writeRawImport(
  id: string,
  body: ReadableStream<Uint8Array>,
  expectedSize: number,
  signal?: AbortSignal
) {
  const target = rawImportPath(id);
  const part = `${target}.part`;
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
    await rename(part, target);
    return target;
  } catch (error) {
    await Promise.all([rm(part, { force: true }), rm(target, { force: true })]);
    throw error;
  }
}

export async function removeRawImport(id: string) {
  const path = rawImportPath(id);
  await Promise.all([rm(path, { force: true }), rm(`${path}.part`, { force: true })]);
}

export async function rawImportExists(id: string) {
  const info = await statIfExists(rawImportPath(id));
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

    const attempt = await tryWithImportSessionLock(id, async () => {
      const referenced = await pool.query(
        "SELECT 1 FROM import_session WHERE id=$1",
        [id]
      );
      if (referenced.rowCount) return false;

      // Recheck age after taking the lifecycle lock so a newly replaced file
      // cannot be removed using stale directory metadata.
      const current = await statIfExists(path);
      if (!current || current.mtimeMs >= cutoff) return false;
      await rm(path, { force: true });
      return true;
    });
    if (attempt.acquired && attempt.value) removed += 1;
  }
  return removed;
}
