import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { env } from "../../config/env.js";
import { ApiError } from "../../core/http.js";
import { nodeReadableFromWeb } from "../../storage/stream-buffer.js";

export function rawImportPath(id: string) {
  const root = env.TEMP_DIR;
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

export async function cleanupOrphanRawImports(maxAgeMs: number) {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  const root = env.TEMP_DIR;
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f-]+\.raw(?:\.part)?$/i.test(entry.name)) continue;
    const path = join(root, entry.name);
    const info = await stat(path).catch(() => null);
    if (info && info.mtimeMs < cutoff) {
      await rm(path, { force: true });
      removed += 1;
    }
  }
  return removed;
}
