import { redis } from "../../core/redis/client.ts";
import { execRedisPipeline } from "../../core/redis/pipeline.ts";
import type { ImageBrowseContext, ImageBrowsePosition } from "../cursor.ts";
import { ReadyImageCoreCacheError } from "./cache-errors.ts";
import { READY_IMAGE_ALL_INDEX_KEY, READY_IMAGE_ID_SUFFIX_LOOKUP_KEY } from "./keys.ts";
import type { ReadyImageFilterIndex } from "./indexes/filter.ts";
import { readyImageMember } from "./model.ts";

const scanLimit = 4_096;
const scanBatch = 256;

/**
 * Walks the existing suffix index, probing the canonical filter membership.
 * Sparse sets exceeding the scan budget use the same bounded PostgreSQL read.
 * Returning null never represents the end of a candidate sequence.
 */
export async function readReadyImageRandomMembers(
  index: ReadyImageFilterIndex,
  context: ImageBrowseContext,
  position: ImageBrowsePosition | undefined,
  limit: number,
  expectedCoreCount: number,
  signal?: AbortSignal
): Promise<string[] | null> {
  const key = READY_IMAGE_ID_SUFFIX_LOOKUP_KEY;
  const counts = redis.pipeline();
  counts.zcard(key);
  counts.zcount(key, "-inf", `(${context.start}`);
  const result = await execRedisPipeline(counts);
  const total = Number(result[0]?.[1]);
  const cut = Number(result[1]?.[1]);
  if (total !== expectedCoreCount || !Number.isSafeInteger(cut) || cut < 0 || cut > total) {
    throw new ReadyImageCoreCacheError("Ready-image suffix index is incomplete");
  }
  let phase = position?.phase ?? 0;
  let start = phase === 0 ? cut : 0;
  if (position) {
    const boundaryMember = readyImageMember(position.id);
    const rank = await redis.zrank(key, boundaryMember);
    if (rank !== null) {
      start = rank + 1;
    } else {
      // Continue across a deleted boundary without relying on a member rank.
      const peers = await redis.zrangebyscore(
        key, position.sortScore, position.sortScore, "LIMIT", 0, scanBatch
      );
      if (peers.length === scanBatch) return null;
      start = await redis.zcount(key, "-inf", `(${position.sortScore}`)
        + peers.filter((id) => id <= boundaryMember).length;
    }
  }
  let scanned = 0;
  const selected: string[] = [];
  while (selected.length < limit + 1) {
    signal?.throwIfAborted();
    const end = phase === 0 ? total : cut;
    if (start >= end) {
      if (phase === 1) return selected;
      phase = 1;
      start = 0;
      continue;
    }
    const count = Math.min(scanBatch, end - start, scanLimit - scanned);
    if (count <= 0) return null;
    const members = await redis.zrange(key, String(start), String(start + count - 1));
    if (members.length !== count) {
      throw new ReadyImageCoreCacheError("Ready-image suffix window is incomplete");
    }
    scanned += count;
    start += count;
    const scores = index.key === READY_IMAGE_ALL_INDEX_KEY
      ? null : await redis.zmscore(index.key, ...members);
    if (scores && scores.length !== members.length) throw new Error("Incomplete filter membership");
    for (let offset = 0; offset < members.length; offset += 1) {
      if (scores && scores[offset] === null) continue;
      selected.push(members[offset]!);
      if (selected.length === limit + 1) break;
    }
  }
  return selected;
}
