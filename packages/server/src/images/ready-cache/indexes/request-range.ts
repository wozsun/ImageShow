import { redis } from "../../../core/redis/client.ts";
import { execRedisPipeline } from "../../../core/redis/pipeline.ts";
import { ReadyImageCoreCacheError } from "../cache-errors.ts";
import { READY_IMAGE_DERIVED_WORK_POLICY } from "../derived/work-policy.ts";
import { READY_IMAGE_ALL_INDEX_KEY, READY_IMAGE_ID_SUFFIX_LOOKUP_KEY } from "../keys.ts";
import { readyImageMember } from "../model.ts";

/** Resolve IDs without hydrating images; scores must match every attribute index. */
export async function readReadyImageIdEntries(ids: readonly string[], coreCount: number) {
  const maximum = READY_IMAGE_DERIVED_WORK_POLICY.maxExpectedResultMembers;
  const members = new Set(ids.filter((id) => id.length > 12).map(readyImageMember));
  const suffixes = ids.filter((id) => id.length === 12);
  const pipeline = redis.pipeline();
  pipeline.zcard(READY_IMAGE_ALL_INDEX_KEY);
  pipeline.zcard(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY);
  for (const suffix of suffixes) {
    const score = Number.parseInt(suffix, 16);
    pipeline.zcount(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, score, score);
  }
  const results = await execRedisPipeline(pipeline);
  if (Number(results[0]?.[1]) !== coreCount || Number(results[1]?.[1]) !== coreCount) {
    throw new ReadyImageCoreCacheError("Ready-image range source cardinality differs from meta");
  }
  const suffixCounts = results.slice(2).map((result) => Number(result[1]));
  if (suffixCounts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new ReadyImageCoreCacheError("Ready-image suffix count is invalid");
  }
  if (members.size + suffixCounts.reduce((sum, count) => sum + count, 0) > maximum) return null;
  if (suffixes.length) {
    const suffixLookup = redis.pipeline();
    for (const [index, suffix] of suffixes.entries()) {
      const score = Number.parseInt(suffix, 16);
      suffixLookup.zrangebyscore(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, score, score, "LIMIT", 0, suffixCounts[index]! + 1);
    }
    const matches = await execRedisPipeline(suffixLookup);
    for (const [index, match] of matches.entries()) {
      const found = match[1] as string[];
      if (found.length !== suffixCounts[index]) {
        throw new ReadyImageCoreCacheError("Ready-image suffix lookup cardinality changed");
      }
      for (const member of found) members.add(member);
    }
  }
  const selected = [...members];
  if (!selected.length) return [];
  const scores = await redis.zmscore(READY_IMAGE_ALL_INDEX_KEY, ...selected);
  if (scores.length !== selected.length) {
    throw new ReadyImageCoreCacheError("Ready-image range score lookup is incomplete");
  }
  return selected.flatMap((member, index) => {
    const raw = scores[index];
    if (raw === null) return [];
    const score = Number(raw);
    if (!Number.isSafeInteger(score)) throw new ReadyImageCoreCacheError("Ready-image range score is invalid");
    return [[score, member] as const];
  });
}
