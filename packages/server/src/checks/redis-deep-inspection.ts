import type { Redis } from "ioredis";
import { abortSignalError, raceWithAbortSignal } from "../core/abort.ts";
import { execRedisPipeline } from "../core/redis/pipeline.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_CACHE_PREFIX,
  READY_IMAGE_DERIVED_INDEX_META_PREFIX,
  READY_IMAGE_DERIVED_INDEX_PREFIX,
  READY_IMAGE_DERIVED_PREFIX,
  READY_IMAGE_FILTER_KEY_PREFIX,
  READY_IMAGE_FILTER_META_KEY_PREFIX,
  READY_IMAGE_STATS_RESULT_KEY_PREFIX
} from "../images/ready-cache/keys.ts";
import { ORIGINAL_DIRECT_CACHE_PREFIX } from "../images/original-direct-cache.ts";
import { adminSessionKeyFamilyPrefix } from "../users/admin-session-key.ts";

const REDIS_DEEP_CHECK_DEADLINE_MS = 10_000;
const REDIS_DEEP_CHECK_MAX_KEYS = 100_000;
const REDIS_DEEP_CHECK_PIPELINE_MAX_COMMANDS = 128;

const REDIS_DEEP_CHECK_MAX_DEADLINE_MS = 60_000;
const REDIS_DEEP_CHECK_MAX_KEY_LIMIT = 1_000_000;
const REDIS_DEEP_CHECK_MAX_PIPELINE_COMMANDS = 1_000;
const REDIS_SCAN_COUNT = 500;
const LOGIN_FAIL_KEY_PREFIX = "imageshow:login_fail:";

const measureKeyScript = `
local kind = redis.call('TYPE', KEYS[1])
if type(kind) == 'table' then kind = kind.ok end
if kind == 'none' then return {kind, 0, 0} end
local memory = redis.call('MEMORY', 'USAGE', KEYS[1], 'SAMPLES', '0') or 0
local members = 0
if kind == 'string' then members = 1
elseif kind == 'hash' then members = redis.call('HLEN', KEYS[1])
elseif kind == 'list' then members = redis.call('LLEN', KEYS[1])
elseif kind == 'set' then members = redis.call('SCARD', KEYS[1])
elseif kind == 'zset' then members = redis.call('ZCARD', KEYS[1])
elseif kind == 'stream' then members = redis.call('XLEN', KEYS[1])
else return redis.error_reply('unsupported ImageShow Redis key type: ' .. kind)
end
return {kind, memory, members}`;

type RedisDeepInspectionClient = Pick<Redis, "scan" | "pipeline">;

type RedisUsageAggregate = {
  key_count: number;
  member_count: number;
  memory_bytes: number;
};

type RedisPrefixCounts = ReturnType<typeof emptyPrefixCounts>;

type RedisDeepInspectionBase = {
  source: "deep";
  measured_at: string;
  scanned_keys: number;
  prefix_counts: RedisPrefixCounts;
  image_projection_usage: {
    core: RedisUsageAggregate;
    derived: RedisUsageAggregate;
  };
};

export type RedisDeepInspectionResult =
  | (RedisDeepInspectionBase & { complete: true })
  | (RedisDeepInspectionBase & {
      complete: false;
      reason: "deadline" | "max_keys";
    });

export type RedisDeepInspectionOptions = {
  client: RedisDeepInspectionClient;
  signal?: AbortSignal;
  deadlineMs?: number;
  maxKeys?: number;
  pipelineMaxCommands?: number;
  now?: () => Date;
};

function checkedBound(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string
) {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved)
    || resolved < 1
    || resolved > maximum
  ) {
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return resolved;
}

function emptyUsage(): RedisUsageAggregate {
  return { key_count: 0, member_count: 0, memory_bytes: 0 };
}

function emptyPrefixCounts() {
  return {
    imageshow_total: 0,
    ready_image_cache: 0,
    ready_image_indexes: 0,
    ready_image_index_meta: 0,
    ready_image_filters: 0,
    ready_image_filter_meta: 0,
    ready_image_stats_results: 0,
    original_direct_cache: 0,
    sessions: 0,
    login_failures: 0,
    temporary: 0,
    other: 0
  };
}

export function resolveRedisDeepInspectionDeadlineMs(value?: number) {
  return checkedBound(
    value,
    REDIS_DEEP_CHECK_DEADLINE_MS,
    REDIS_DEEP_CHECK_MAX_DEADLINE_MS,
    "Redis deep inspection deadlineMs"
  );
}

function countPrefix(key: string, counts: RedisPrefixCounts) {
  counts.imageshow_total += 1;
  if (key.startsWith(READY_IMAGE_CACHE_PREFIX)) {
    counts.ready_image_cache += 1;
    if (
      key === READY_IMAGE_ALL_INDEX_KEY
      || key.startsWith(READY_IMAGE_DERIVED_INDEX_PREFIX)
    ) {
      counts.ready_image_indexes += 1;
    } else if (key.startsWith(READY_IMAGE_DERIVED_INDEX_META_PREFIX)) {
      counts.ready_image_index_meta += 1;
    } else if (key.startsWith(READY_IMAGE_FILTER_META_KEY_PREFIX)) {
      counts.ready_image_filter_meta += 1;
    } else if (key.startsWith(READY_IMAGE_FILTER_KEY_PREFIX)) {
      counts.ready_image_filters += 1;
    } else if (key.startsWith(READY_IMAGE_STATS_RESULT_KEY_PREFIX)) {
      counts.ready_image_stats_results += 1;
    }
  } else if (key.startsWith(ORIGINAL_DIRECT_CACHE_PREFIX)) {
    counts.original_direct_cache += 1;
  } else if (key.startsWith(adminSessionKeyFamilyPrefix)) {
    counts.sessions += 1;
  } else if (key.startsWith(LOGIN_FAIL_KEY_PREFIX)) {
    counts.login_failures += 1;
  } else {
    counts.other += 1;
  }
  if (
    key.includes(":tmp:")
    || key.startsWith(`${READY_IMAGE_DERIVED_PREFIX}temp:`)
  ) {
    counts.temporary += 1;
  }
}

function nonNegativeSafeInteger(value: unknown, field: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Redis deep inspection returned invalid ${field}`);
  }
  return number;
}

function addUsage(
  aggregate: RedisUsageAggregate,
  memory: number,
  members: number
) {
  aggregate.key_count += 1;
  aggregate.memory_bytes += memory;
  aggregate.member_count += members;
  if (
    !Number.isSafeInteger(aggregate.memory_bytes)
    || !Number.isSafeInteger(aggregate.member_count)
  ) {
    throw new Error("Redis deep inspection aggregate is outside the safe range");
  }
}

function measuredResult(
  state: Omit<RedisDeepInspectionBase, "source" | "measured_at">,
  now: () => Date,
  reason?: "deadline" | "max_keys"
): RedisDeepInspectionResult {
  const base: RedisDeepInspectionBase = {
    source: "deep",
    measured_at: now().toISOString(),
    ...state
  };
  return reason
    ? { ...base, complete: false, reason }
    : { ...base, complete: true };
}

export function redisDeepInspectionDeadlineResult(
  partial: RedisDeepInspectionResult | null = null,
  now: () => Date = () => new Date()
): RedisDeepInspectionResult {
  return measuredResult(partial ? {
    scanned_keys: partial.scanned_keys,
    prefix_counts: partial.prefix_counts,
    image_projection_usage: partial.image_projection_usage
  } : {
    scanned_keys: 0,
    prefix_counts: emptyPrefixCounts(),
    image_projection_usage: {
      core: emptyUsage(),
      derived: emptyUsage()
    }
  }, now, "deadline");
}

/**
 * Scans only the ImageShow keyspace and measures owned projection keys in
 * bounded pipelines. Each per-key Lua call observes type, cardinality and
 * MEMORY USAGE atomically, so expiring derived keys cannot create WRONGTYPE
 * races between separate commands.
 */
export async function inspectRedisKeyspaceDeep(
  options: RedisDeepInspectionOptions
): Promise<RedisDeepInspectionResult> {
  const deadlineMs = resolveRedisDeepInspectionDeadlineMs(options.deadlineMs);
  const maxKeys = checkedBound(
    options.maxKeys,
    REDIS_DEEP_CHECK_MAX_KEYS,
    REDIS_DEEP_CHECK_MAX_KEY_LIMIT,
    "Redis deep inspection maxKeys"
  );
  const pipelineMaxCommands = checkedBound(
    options.pipelineMaxCommands,
    REDIS_DEEP_CHECK_PIPELINE_MAX_COMMANDS,
    REDIS_DEEP_CHECK_MAX_PIPELINE_COMMANDS,
    "Redis deep inspection pipelineMaxCommands"
  );
  const now = options.now ?? (() => new Date());
  const deadline = new AbortController();
  const deadlineError = new Error("Redis deep inspection deadline reached");
  const timer = setTimeout(() => deadline.abort(deadlineError), deadlineMs);
  const operationSignal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  const state = {
    scanned_keys: 0,
    prefix_counts: emptyPrefixCounts(),
    image_projection_usage: {
      core: emptyUsage(),
      derived: emptyUsage()
    }
  };
  const observedKeys = new Set<string>();

  const run = <T>(operation: Promise<T>) => raceWithAbortSignal(
    operationSignal,
    operation,
    "Redis deep inspection aborted"
  );

  const measureKeys = async (keys: string[]) => {
    const projectionKeys = keys.filter((key) => (
      key.startsWith(READY_IMAGE_CACHE_PREFIX)
    ));
    for (
      let offset = 0;
      offset < projectionKeys.length;
      offset += pipelineMaxCommands
    ) {
      operationSignal.throwIfAborted();
      const batch = projectionKeys.slice(
        offset,
        offset + pipelineMaxCommands
      );
      const pipeline = options.client.pipeline();
      for (const key of batch) pipeline.eval(measureKeyScript, 1, key);
      const results = await run(execRedisPipeline(pipeline));
      results.forEach(([, raw], index) => {
        const value = raw as unknown;
        if (!Array.isArray(value) || value.length !== 3) {
          throw new Error("Redis deep inspection returned an invalid key sample");
        }
        const [kind, rawMemory, rawMembers] = value;
        if (kind === "none") return;
        if (typeof kind !== "string") {
          throw new Error("Redis deep inspection returned an invalid key type");
        }
        const key = batch[index]!;
        const aggregate = key.startsWith(READY_IMAGE_DERIVED_PREFIX)
          ? state.image_projection_usage.derived
          : state.image_projection_usage.core;
        addUsage(
          aggregate,
          nonNegativeSafeInteger(rawMemory, "memory usage"),
          nonNegativeSafeInteger(rawMembers, "member count")
        );
      });
    }
  };

  try {
    let cursor = "0";
    do {
      operationSignal.throwIfAborted();
      const reply = await run(options.client.scan(
        cursor,
        "MATCH",
        "imageshow:*",
        "COUNT",
        REDIS_SCAN_COUNT
      ));
      if (
        !Array.isArray(reply)
        || reply.length !== 2
        || typeof reply[0] !== "string"
        || !Array.isArray(reply[1])
      ) {
        throw new Error("Redis deep inspection returned an invalid SCAN page");
      }
      const [nextCursor, keys] = reply;
      const accepted: string[] = [];
      let maxExceeded = false;
      for (const key of keys) {
        if (typeof key !== "string" || observedKeys.has(key)) continue;
        if (observedKeys.size >= maxKeys) {
          maxExceeded = true;
          break;
        }
        observedKeys.add(key);
        accepted.push(key);
        countPrefix(key, state.prefix_counts);
      }
      state.scanned_keys = observedKeys.size;
      await measureKeys(accepted);
      if (maxExceeded) return measuredResult(state, now, "max_keys");
      cursor = nextCursor;
    } while (cursor !== "0");
    return measuredResult(state, now);
  } catch (error) {
    if (options.signal?.aborted) {
      throw abortSignalError(options.signal, "Redis deep inspection aborted");
    }
    if (deadline.signal.aborted) {
      return measuredResult(state, now, "deadline");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
