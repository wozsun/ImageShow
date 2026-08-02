import { pool } from "../core/db.ts";
import { redis } from "../core/redis-client.ts";
import { execRedisPipeline } from "../core/redis-pipeline.ts";
import { randomUuidV7 } from "../core/uuid.ts";
import { runSharedRandomBuild } from "./build-lifecycle.ts";
import { waitForRandomFilterConsistency } from "./cache-consistency.ts";
import {
  readRandomPoolSnapshot,
  rebuildRandomPool,
  scheduleRandomRebuild
} from "./cache-rebuild.ts";
import {
  GALLERY_FILTER_OPTIONS_KEY,
  RANDOM_MUTATION_REVISION_KEY,
  RANDOM_REBUILD_COMPLETED_KEY,
  RANDOM_UPDATE_LOCK_KEY,
  randomAuthorSetKey,
  randomFilterKey,
  randomItemKey,
  randomTagSetKey
} from "./cache-keys.ts";
import {
  filterOptionsFromCategoryCounts,
  parseRandomPoolItem,
  type GalleryFilterOptions,
  type RandomPoolItem,
  type RandomPoolSnapshot
} from "./cache-model.ts";
import {
  RANDOM_CLEANUP_BATCH_SIZE,
  RANDOM_FILTER_CONSISTENCY_WAIT_MS,
  RANDOM_FILTER_TTL_SECONDS,
  randomPoolUpdating,
  randomPoolRetry,
  redisUnavailable
} from "./cache-policy.ts";
import {
  RANDOM_FILTER_CACHE_READ_SCRIPT,
  RANDOM_FILTER_PUBLISH_SCRIPT
} from "./cache-scripts.ts";

export async function getRandomPoolSnapshot(
  signal?: AbortSignal
): Promise<RandomPoolSnapshot> {
  try {
    return await readRandomPoolSnapshot()
      ?? await rebuildRandomPool({ requireFresh: false, signal });
  } catch (error) {
    if (randomPoolRetry(error)) throw error;
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
    .map(parseRandomPoolItem)
    .filter((item): item is RandomPoolItem => Boolean(item));
}

type RandomFilterInput = {
  generation: string;
  signature: string;
  baseSetKeys: string[];
  tagInclude: string[];
  tagExclude: string[];
  authorInclude: string[];
  authorExclude: string[];
};

async function buildRandomFilterSetAtRevision(
  input: RandomFilterInput,
  revision: string,
  callerSignal?: AbortSignal
) {
  const signature = `${input.signature}|r=${revision}`;
  const finalKey = randomFilterKey(input.generation, signature, "final");
  const emptyKey = randomFilterKey(input.generation, signature, "empty");
  return runSharedRandomBuild(`random-filter:${finalKey}`, async (signal) => {
    signal.throwIfAborted();
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
    signal.throwIfAborted();
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

    const storeTemporarySet = async (
      command: "sunionstore" | "sinterstore" | "sdiffstore",
      destination: string,
      sources: string[]
    ) => {
      signal.throwIfAborted();
      const transaction = redis.multi();
      if (sources.length) {
        transaction[command](destination, ...sources);
        transaction.expire(destination, RANDOM_FILTER_TTL_SECONDS);
      } else {
        transaction.unlink(destination);
      }
      await execRedisPipeline(transaction);
      signal.throwIfAborted();
    };

    try {
      await storeTemporarySet("sunionstore", current, input.baseSetKeys);

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
        await storeTemporarySet("sunionstore", key, sourceKeys);
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
        await storeTemporarySet("sinterstore", next, [current, source]);
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
        await storeTemporarySet("sdiffstore", next, [current, source]);
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

      await storeTemporarySet("sunionstore", candidateKey, [current]);
      signal.throwIfAborted();
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
      signal.throwIfAborted();
      if (!Number(publication[0])) return null;
      return { key: finalKey, count: Number(publication[1]) };
    } finally {
      const ownedKeys = [...new Set([...tempKeys, candidateKey])];
      try {
        for (
          let index = 0;
          index < ownedKeys.length;
          index += RANDOM_CLEANUP_BATCH_SIZE
        ) {
          await redis.unlink(
            ...ownedKeys.slice(index, index + RANDOM_CLEANUP_BATCH_SIZE)
          );
        }
      } catch {
        // Every candidate receives its TTL in the same Redis transaction as
        // its contents, so a failed best-effort UNLINK still has a bound.
      }
    }
  }, callerSignal);
}

export async function buildRandomFilterSet(
  input: RandomFilterInput,
  signal?: AbortSignal
): Promise<{ key: string; count: number }> {
  const deadline = Date.now() + RANDOM_FILTER_CONSISTENCY_WAIT_MS;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const consistency = await waitForRandomFilterConsistency({
        deadline,
        signal
      });
      if (consistency.status === "stale") {
        await scheduleRandomRebuild();
        throw redisUnavailable();
      }
      if (consistency.status === "updating") {
        throw randomPoolUpdating();
      }

      const result = await buildRandomFilterSetAtRevision(
        input,
        consistency.revision,
        signal
      );
      if (result) return result;
      if (Date.now() >= deadline) throw randomPoolUpdating();
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (randomPoolRetry(error)) throw error;
    throw redisUnavailable();
  }
}
