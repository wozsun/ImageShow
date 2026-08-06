import type { Redis } from "ioredis";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";

export const REDIS_BATCH_MAX_COMMANDS = 250;
const REDIS_BATCH_MAX_BYTES = 512 * 1024;

type RedisPipeline = ReturnType<Redis["pipeline"]>;

export function estimatedRedisBytes(...values: Array<string | number>) {
  let total = 0;
  for (const value of values) {
    total += Buffer.byteLength(String(value), "utf8") + 16;
  }
  return total;
}

export class RedisPipelineBatcher {
  readonly #client: Redis;
  #pipeline: RedisPipeline;
  #commands = 0;
  #bytes = 0;

  constructor(client: Redis) {
    this.#client = client;
    this.#pipeline = client.pipeline();
  }

  async queue(
    estimatedBytes: number,
    enqueue: (pipeline: RedisPipeline) => void
  ) {
    if (
      this.#commands > 0
      && (
        this.#commands >= REDIS_BATCH_MAX_COMMANDS
        || this.#bytes + estimatedBytes > REDIS_BATCH_MAX_BYTES
      )
    ) {
      await this.flush();
    }
    enqueue(this.#pipeline);
    this.#commands += 1;
    this.#bytes += estimatedBytes;
  }

  async flush() {
    if (!this.#commands) return;
    const pipeline = this.#pipeline;
    this.#pipeline = this.#client.pipeline();
    this.#commands = 0;
    this.#bytes = 0;
    await execRedisPipeline(pipeline);
  }
}

export function* chunkHashEntries(
  entries: Iterable<readonly [string, string]>
) {
  let chunk: Array<[string, string]> = [];
  let bytes = 0;
  for (const [field, value] of entries) {
    const entryBytes = estimatedRedisBytes(field, value);
    if (chunk.length && bytes + entryBytes > REDIS_BATCH_MAX_BYTES) {
      yield chunk;
      chunk = [];
      bytes = 0;
    }
    chunk.push([field, value]);
    bytes += entryBytes;
  }
  if (chunk.length) yield chunk;
}

export function* chunkSortedSetEntries(
  key: string,
  entries: Iterable<readonly [string | number, string]>
) {
  let chunk: Array<readonly [string | number, string]> = [];
  let bytes = estimatedRedisBytes(key);
  for (const [score, member] of entries) {
    const entryBytes = estimatedRedisBytes(score, member);
    if (chunk.length && bytes + entryBytes > REDIS_BATCH_MAX_BYTES) {
      yield chunk;
      chunk = [];
      bytes = estimatedRedisBytes(key);
    }
    chunk.push([score, member]);
    bytes += entryBytes;
  }
  if (chunk.length) yield chunk;
}
