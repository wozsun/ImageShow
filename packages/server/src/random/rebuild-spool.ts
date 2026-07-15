import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  open,
  readdir,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runtimePaths } from "../config/bootstrap-env.ts";

const RANDOM_REBUILD_MEMORY_THRESHOLD_BYTES = 16 * 1024 * 1024;
const RANDOM_REBUILD_MAX_BATCH_BYTES = 16 * 1024 * 1024;
const RANDOM_REBUILD_MAX_SPOOL_BYTES = 16 * 1024 * 1024 * 1024;
const randomRebuildSpoolPrefix = "imageshow-random-rebuild-";
const randomRebuildSpoolPattern = /^imageshow-random-rebuild-[0-9a-f-]{36}\.ndjson$/i;

type RandomRebuildBatchStoreStats = {
  itemCount: number;
  batchCount: number;
  serializedBytes: number;
  peakMemoryPayloadBytes: number;
  storage: "memory" | "spool";
  spoolBytes: number;
};

export type RandomRebuildBatchStore<T> = {
  append(items: T[]): Promise<void>;
  seal(): Promise<void>;
  batches(): AsyncGenerator<T[]>;
  stats(): RandomRebuildBatchStoreStats;
  cleanup(): Promise<void>;
};

type ActiveSpool = { cleanup(): Promise<void> };
const activeSpools = new Set<ActiveSpool>();

function spoolPath() {
  return join(
    runtimePaths.tempDirectory,
    `${randomRebuildSpoolPrefix}${randomUUID()}.ndjson`,
  );
}

export function createRandomRebuildBatchStore<T>(options: {
  validateBatch: (value: unknown) => T[];
  memoryThresholdBytes?: number;
}): RandomRebuildBatchStore<T> {
  const memoryThresholdBytes = Math.max(
    0,
    Math.floor(options.memoryThresholdBytes ?? RANDOM_REBUILD_MEMORY_THRESHOLD_BYTES),
  );
  let memoryBatches: string[] = [];
  let memoryBytes = 0;
  let peakMemoryPayloadBytes = 0;
  let fileHandle: FileHandle | null = null;
  let filePath = "";
  let spoolBytes = 0;
  let serializedBytes = 0;
  let itemCount = 0;
  let batchCount = 0;
  let sealed = false;
  let cleaned = false;

  const store: RandomRebuildBatchStore<T> = {
    async append(items) {
      if (sealed || cleaned) throw new Error("Random rebuild batch store is closed");
      options.validateBatch(items);
      const serialized = JSON.stringify(items);
      const lineBytes = Buffer.byteLength(serialized, "utf8");
      if (lineBytes > RANDOM_REBUILD_MAX_BATCH_BYTES) {
        throw new Error("Random rebuild batch exceeds spool line limit");
      }

      serializedBytes += lineBytes;
      itemCount += items.length;
      batchCount += 1;
      peakMemoryPayloadBytes = Math.max(peakMemoryPayloadBytes, memoryBytes + lineBytes);

      if (!fileHandle && memoryBytes + lineBytes <= memoryThresholdBytes) {
        memoryBatches.push(serialized);
        memoryBytes += lineBytes;
        return;
      }

      if (!fileHandle) {
        filePath = spoolPath();
        fileHandle = await open(filePath, "wx", 0o600);
        activeSpools.add(store);
        for (const memoryBatch of memoryBatches) {
          await writeSpoolLine(memoryBatch);
        }
        memoryBatches = [];
        memoryBytes = 0;
      }
      await writeSpoolLine(serialized);
    },

    async seal() {
      if (sealed || cleaned) return;
      sealed = true;
      if (fileHandle) {
        await fileHandle.sync();
        await fileHandle.close();
        fileHandle = null;
      }
    },

    async *batches() {
      if (!sealed || cleaned) throw new Error("Random rebuild batch store is not readable");
      if (!filePath) {
        for (const serialized of memoryBatches) {
          yield parseBatch(serialized);
        }
        return;
      }

      const fileStats = await stat(filePath);
      if (fileStats.size !== spoolBytes || fileStats.size > RANDOM_REBUILD_MAX_SPOOL_BYTES) {
        throw new Error("Random rebuild spool size validation failed");
      }

      let readBytes = 0;
      let readBatchCount = 0;
      let readItemCount = 0;
      const lines = createInterface({
        input: createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        const lineBytes = Buffer.byteLength(line, "utf8");
        if (!line || lineBytes > RANDOM_REBUILD_MAX_BATCH_BYTES) {
          throw new Error("Random rebuild spool line validation failed");
        }
        const batch = parseBatch(line);
        readBytes += lineBytes + 1;
        readBatchCount += 1;
        readItemCount += batch.length;
        yield batch;
      }
      if (
        readBytes !== spoolBytes
        || readBatchCount !== batchCount
        || readItemCount !== itemCount
      ) {
        throw new Error("Random rebuild spool content validation failed");
      }
    },

    stats() {
      return {
        itemCount,
        batchCount,
        serializedBytes,
        peakMemoryPayloadBytes,
        storage: filePath ? "spool" : "memory",
        spoolBytes,
      };
    },

    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (fileHandle) {
        await fileHandle.close().catch(() => undefined);
        fileHandle = null;
      }
      if (filePath) await unlink(filePath).catch(() => undefined);
      memoryBatches = [];
      memoryBytes = 0;
      activeSpools.delete(store);
    },
  };

  async function writeSpoolLine(serialized: string) {
    if (!fileHandle) throw new Error("Random rebuild spool is not open");
    const bytes = Buffer.byteLength(serialized, "utf8") + 1;
    if (spoolBytes + bytes > RANDOM_REBUILD_MAX_SPOOL_BYTES) {
      throw new Error("Random rebuild spool exceeds size limit");
    }
    await fileHandle.writeFile(`${serialized}\n`, { encoding: "utf8" });
    spoolBytes += bytes;
  }

  function parseBatch(serialized: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("Random rebuild spool contains invalid JSON");
    }
    return options.validateBatch(parsed);
  }

  return store;
}

export async function cleanupOrphanRandomRebuildSpools() {
  const entries = await readdir(runtimePaths.tempDirectory, { withFileTypes: true })
    .catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isFile() && randomRebuildSpoolPattern.test(entry.name))
    .map((entry) => unlink(join(runtimePaths.tempDirectory, entry.name)).catch(() => undefined)));
}

export async function cleanupActiveRandomRebuildSpools() {
  await Promise.all([...activeSpools].map((spool) => spool.cleanup()));
}
