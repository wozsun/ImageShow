import { pool } from "../core/db.ts";
import { redis } from "../core/redis-client.ts";
import { execRedisPipeline } from "../core/redis-pipeline.ts";
import { coalesce } from "../core/coalesce.ts";
import { randomUuidV7 } from "../core/uuid.ts";
import {
  readRandomPoolSnapshot,
  rebuildRandomPool,
  scheduleRandomRebuild
} from "./cache-rebuild.ts";
import {
  GALLERY_FILTER_OPTIONS_KEY,
  RANDOM_FILTER_BUILD_MAX_ATTEMPTS,
  RANDOM_FILTER_BUILD_RETRY_INTERVAL_MS,
  RANDOM_FILTER_CACHE_READ_SCRIPT,
  RANDOM_FILTER_PUBLISH_SCRIPT,
  RANDOM_FILTER_TTL_SECONDS,
  RANDOM_MUTATION_REVISION_KEY,
  RANDOM_REBUILD_COMPLETED_KEY,
  RANDOM_UPDATE_LOCK_KEY,
  filterOptionsFromCategoryCounts,
  parseRandomItem,
  randomAuthorSetKey,
  randomFilterKey,
  randomItemKey,
  randomTagSetKey,
  redisUnavailable,
  type GalleryFilterOptions,
  type RandomPoolItem,
  type RandomPoolSnapshot
} from "./cache-schema.ts";

export async function getRandomPoolSnapshot(): Promise<RandomPoolSnapshot> {
  try {
    return await readRandomPoolSnapshot()
      ?? await rebuildRandomPool({ requireFresh: false });
  } catch {
    throw redisUnavailable();
  }
}

export async function getRandomCategoryCounts() {
  return (await getRandomPoolSnapshot()).categoryCounts;
}

export async function getGalleryFilterOptions() {
  try {
    const raw = await redis.get(GALLERY_FILTER_OPTIONS_KEY);
    if (raw) return JSON.parse(raw) as GalleryFilterOptions;
    return filterOptionsFromCategoryCounts(
      (await getRandomPoolSnapshot()).categoryCounts
    );
  } catch {
    const result = await pool.query(
      "SELECT DISTINCT theme FROM metadata WHERE status='ready' ORDER BY theme"
    );
    return {
      devices: ["pc", "mb"],
      brightnesses: ["light", "dark"],
      themes: result.rows.map((row) => row.theme as string)
    };
  }
}

export async function sampleRandomPoolItems(
  setKey: string,
  count: number,
  generation: string
): Promise<RandomPoolItem[]> {
  const raws = await redis.eval(
    `local ids = redis.call("SRANDMEMBER", KEYS[1], ARGV[1])
     if #ids == 0 then return {} end
     return redis.call("HMGET", KEYS[2], unpack(ids))`,
    2,
    setKey,
    randomItemKey(generation),
    Math.max(1, count)
  ) as Array<string | null>;
  return raws
    .map(parseRandomItem)
    .filter((item): item is RandomPoolItem => Boolean(item));
}

export async function buildRandomFilterSet(input: {
  generation: string;
  signature: string;
  baseSetKeys: string[];
  tagInclude: string[];
  tagExclude: string[];
  authorInclude: string[];
  authorExclude: string[];
}): Promise<{ key: string; count: number }> {
  for (
    let attempt = 0;
    attempt < RANDOM_FILTER_BUILD_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const revision = await redis.get(RANDOM_MUTATION_REVISION_KEY)
      .catch(() => "0") ?? "0";
    const signature = `${input.signature}|r=${revision}`;
    const finalKey = randomFilterKey(input.generation, signature, "final");
    const emptyKey = randomFilterKey(input.generation, signature, "empty");
    const result = await coalesce(`random-filter:${finalKey}`, async () => {
      const cachedCount = Number(await redis.eval(
        RANDOM_FILTER_CACHE_READ_SCRIPT,
        5,
        finalKey,
        emptyKey,
        RANDOM_MUTATION_REVISION_KEY,
        RANDOM_REBUILD_COMPLETED_KEY,
        RANDOM_UPDATE_LOCK_KEY,
        revision,
        RANDOM_FILTER_TTL_SECONDS
      ));
      if (cachedCount === -2) return null;
      if (cachedCount >= 0) return { key: finalKey, count: cachedCount };

      const tempKeys: string[] = [];
      const buildToken = randomUuidV7();
      let current = randomFilterKey(
        input.generation,
        signature,
        `base-${buildToken}`
      );
      const candidateKey = randomFilterKey(
        input.generation,
        signature,
        `candidate-${buildToken}`
      );
      tempKeys.push(current);
      try {
        if (!input.baseSetKeys.length) {
          await redis.del(current);
        } else if (input.baseSetKeys.length === 1) {
          await redis.sunionstore(current, input.baseSetKeys[0]);
        } else {
          await redis.sunionstore(current, ...input.baseSetKeys);
        }

        const applyUnion = async (
          kind: "tag" | "author",
          values: string[],
          suffix: string
        ) => {
          if (!values.length) return "";
          const key = randomFilterKey(
            input.generation,
            signature,
            `${suffix}-${buildToken}`
          );
          const sourceKeys = values.map((value) => kind === "tag"
            ? randomTagSetKey(input.generation, value)
            : randomAuthorSetKey(input.generation, value));
          tempKeys.push(key);
          await redis.sunionstore(key, ...sourceKeys);
          return key;
        };

        const intersectWith = async (source: string, suffix: string) => {
          if (!source) return;
          const next = randomFilterKey(
            input.generation,
            signature,
            `${suffix}-${buildToken}`
          );
          tempKeys.push(next);
          await redis.sinterstore(next, current, source);
          current = next;
        };

        const diffWith = async (source: string, suffix: string) => {
          if (!source) return;
          const next = randomFilterKey(
            input.generation,
            signature,
            `${suffix}-${buildToken}`
          );
          tempKeys.push(next);
          await redis.sdiffstore(next, current, source);
          current = next;
        };

        await intersectWith(
          await applyUnion("tag", input.tagInclude, "tag-include"),
          "after-tag-include"
        );
        await diffWith(
          await applyUnion("tag", input.tagExclude, "tag-exclude"),
          "after-tag-exclude"
        );
        await intersectWith(
          await applyUnion("author", input.authorInclude, "author-include"),
          "after-author-include"
        );
        await diffWith(
          await applyUnion("author", input.authorExclude, "author-exclude"),
          "after-author-exclude"
        );

        await redis.sunionstore(candidateKey, current);
        const publication = await redis.eval(
          RANDOM_FILTER_PUBLISH_SCRIPT,
          6,
          finalKey,
          emptyKey,
          candidateKey,
          RANDOM_MUTATION_REVISION_KEY,
          RANDOM_REBUILD_COMPLETED_KEY,
          RANDOM_UPDATE_LOCK_KEY,
          revision,
          RANDOM_FILTER_TTL_SECONDS
        ) as [number, number];
        const pipeline = redis.pipeline();
        for (const key of tempKeys) {
          pipeline.expire(key, RANDOM_FILTER_TTL_SECONDS);
        }
        await execRedisPipeline(pipeline);
        if (!Number(publication[0])) return null;
        return { key: finalKey, count: Number(publication[1]) };
      } catch (error) {
        const cleanup = redis.pipeline();
        for (const key of new Set([...tempKeys, candidateKey])) {
          cleanup.expire(key, RANDOM_FILTER_TTL_SECONDS);
        }
        await execRedisPipeline(cleanup).catch(() => undefined);
        throw error;
      }
    });
    if (result) return result;
    if (attempt + 1 < RANDOM_FILTER_BUILD_MAX_ATTEMPTS) {
      await new Promise((resolve) => {
        setTimeout(resolve, RANDOM_FILTER_BUILD_RETRY_INTERVAL_MS);
      });
    }
  }
  await scheduleRandomRebuild();
  throw redisUnavailable();
}
