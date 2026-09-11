import { createReadStream } from "node:fs";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { finished } from "node:stream/promises";
import { getIngestionMaxFileBytes } from "../../../config/app-settings.ts";
import { ApiError } from "../../../core/api-error.ts";
import { openedReadToBuffer } from "../../../storage/objects/stream-buffer.ts";
import { ingestionPreparedPath } from "./paths.ts";
import {
  pruneIngestionTempParents,
  tryWithInactiveIngestionTempPath,
  withActiveIngestionTempPaths
} from "./lease-registry.ts";

/** The caller holds the attempt's path leases through canonical publication. */
export async function writeIngestionPreparedFile(
  file: string,
  body: Buffer,
  signal: AbortSignal
) {
  const path = ingestionPreparedPath(file);
  const part = `${path}.part`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(part, body, { flag: "wx", signal });
    signal.throwIfAborted();
    await link(part, path);
  } finally {
    await rm(part, { force: true });
  }
}

export function readIngestionPreparedFile(file: string, signal?: AbortSignal) {
  const path = ingestionPreparedPath(file);
  return withActiveIngestionTempPaths([path], async () => {
    const body = createReadStream(path, { signal });
    const closed = finished(body, { cleanup: true }).catch(() => undefined);
    try {
      return await openedReadToBuffer({
        body, size: undefined, totalSize: undefined, backend: "local"
      }, getIngestionMaxFileBytes());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ApiError(404, "not_found", "准备好的图片不存在");
      }
      throw error;
    } finally {
      body.destroy();
      await closed;
    }
  });
}

export async function removeIngestionPreparedFiles(files: readonly string[]) {
  const results = await Promise.allSettled(files.map(async (file) => {
    const path = ingestionPreparedPath(file);
    const removed = await tryWithInactiveIngestionTempPath(path, async () => {
      await rm(path, { force: true });
      return true;
    });
    if (!removed) throw new Error("Prepared ingestion file is in use");
    await pruneIngestionTempParents(path);
  }));
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Prepared ingestion cleanup failed");
}
