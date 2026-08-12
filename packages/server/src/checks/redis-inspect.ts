import type { Redis } from "ioredis";
import { deploymentConfig } from "../config/deployment-config.ts";
import {
  abortSignalError,
  raceWithAbortSignal
} from "../core/abort.ts";
import {
  parseRedisInfoFields,
  parseRedisMemoryState,
  pingRedis,
  readRequiredRedisCommandCapabilities,
  redis
} from "../core/redis-client.ts";
import {
  getReadyImageCacheCoordinatorStatus
} from "../images/ready-cache/coordinator.ts";
import { readReadyImageCacheMeta } from "../images/ready-cache/meta.ts";
import {
  readReadyImageCacheAdminStatus
} from "../images/ready-cache/admin-status.ts";
import {
  READY_IMAGE_CORE_KEYS,
  READY_IMAGE_EMPTY_CORE_KEYS
} from "../images/ready-cache/keys.ts";
import {
  inspectRedisKeyspaceDeep,
  redisDeepInspectionDeadlineResult,
  resolveRedisDeepInspectionDeadlineMs,
  type RedisDeepInspectionResult,
  type RedisDeepInspectionOptions
} from "./redis-deep-inspection.ts";

type RedisInspectionOptions = Omit<
  RedisDeepInspectionOptions,
  "client" | "signal"
> & { dependencies?: RedisInspectionDependencies };

type RedisInspectionClient = Pick<
  Redis,
  "status" | "info" | "dbsize" | "scan" | "pipeline"
>;

type RedisInspectionDependencies = {
  client: RedisInspectionClient;
  ping: typeof pingRedis;
  readMeta: typeof readReadyImageCacheMeta;
  readRequiredCommands(signal?: AbortSignal): ReturnType<
    typeof readRequiredRedisCommandCapabilities
  >;
  readProjection: typeof readReadyImageCacheAdminStatus;
  coordinatorStatus: typeof getReadyImageCacheCoordinatorStatus;
};

const defaultRedisInspectionDependencies: RedisInspectionDependencies = {
  client: redis,
  ping: pingRedis,
  readMeta: readReadyImageCacheMeta,
  readRequiredCommands: (signal) =>
    readRequiredRedisCommandCapabilities(redis, signal),
  readProjection: readReadyImageCacheAdminStatus,
  coordinatorStatus: getReadyImageCacheCoordinatorStatus
};

function unknownMemoryState(memoryInfo: string | null) {
  if (!memoryInfo) {
    return {
      used_memory_bytes: null,
      used_memory_rss_bytes: null
    };
  }
  try {
    const memory = parseRedisMemoryState(memoryInfo);
    return {
      ...parseRedisInfo(memoryInfo),
      used_memory_bytes: memory.usedMemory,
      used_memory_rss_bytes: memory.usedMemoryRss
    };
  } catch {
    return {
      used_memory_bytes: null,
      used_memory_rss_bytes: null
    };
  }
}

function deadlineInspectionResponse(options: {
  dependencies: RedisInspectionDependencies;
  serverInfo: string | null;
  memoryInfo: string | null;
  keyspaceInfo: string | null;
  dbsize: number | null;
  requiredCommands: Awaited<
    ReturnType<typeof readRequiredRedisCommandCapabilities>
  > | null;
  projection: Awaited<ReturnType<typeof readReadyImageCacheAdminStatus>> | null;
  deepInspection: RedisDeepInspectionResult | null;
  now?: () => Date;
}) {
  return {
    connection: {
      status: options.dependencies.client.status,
      configured_db: deploymentConfig.redis.db,
      redis_version: options.serverInfo
        ? parseRedisInfo(
            options.serverInfo,
            new Set(["redis_version"])
          ).redis_version ?? "unknown"
        : "unknown",
      dbsize: options.dbsize,
      required_commands: options.requiredCommands?.commands ?? null,
      memory: unknownMemoryState(options.memoryInfo),
      keyspace: options.keyspaceInfo
        ? parseRedisInfo(options.keyspaceInfo)
        : {}
    },
    deep_inspection: redisDeepInspectionDeadlineResult(
      options.deepInspection,
      options.now
    ),
    image_projection: options.projection,
    issues: [
      "Redis 手动检查达到总期限；部分结果不代表当前总量"
    ]
  };
}

export async function inspectRedisState(
  signal?: AbortSignal,
  options: RedisInspectionOptions = {}
) {
  signal?.throwIfAborted();
  const {
    dependencies = defaultRedisInspectionDependencies,
    ...deepOptions
  } = options;
  const deadlineMs = resolveRedisDeepInspectionDeadlineMs(
    deepOptions.deadlineMs
  );
  const deadlineAt = performance.now() + deadlineMs;
  const deadline = new AbortController();
  const inspection = new AbortController();
  const deadlineError = new Error("Redis inspection total deadline reached");
  const deadlineTimer = setTimeout(
    () => deadline.abort(deadlineError),
    deadlineMs
  );
  const operationSignal = AbortSignal.any([
    ...(signal ? [signal] : []),
    deadline.signal,
    inspection.signal
  ]);
  const run = <T>(operation: Promise<T>) => raceWithAbortSignal(
    operationSignal,
    operation,
    "Redis inspection aborted"
  );
  let serverInfo: string | null = null;
  let memoryInfo: string | null = null;
  let keyspaceInfo: string | null = null;
  let dbsize: number | null = null;
  let deepInspection: RedisDeepInspectionResult | null = null;
  let deepInspectionPromise: Promise<RedisDeepInspectionResult> | null = null;
  let inspectionTasks: readonly Promise<unknown>[] = [];
  let persistedMeta: Awaited<ReturnType<typeof readReadyImageCacheMeta>> = null;
  let requiredCommands: Awaited<
    ReturnType<typeof readRequiredRedisCommandCapabilities>
  > | null = null;
  let projection: Awaited<ReturnType<typeof readReadyImageCacheAdminStatus>>
    | null = null;

  try {
    await run(dependencies.ping(operationSignal));
    operationSignal.throwIfAborted();
    const remainingMs = Math.max(
      1,
      Math.ceil(deadlineAt - performance.now())
    );
    deepInspectionPromise = inspectRedisKeyspaceDeep({
      ...deepOptions,
      deadlineMs: remainingMs,
      client: dependencies.client,
      signal: signal
        ? AbortSignal.any([signal, inspection.signal])
        : inspection.signal
    }).then((value) => {
      deepInspection = value;
      return value;
    });
    const readOptionalMeta = async () => {
      try {
        persistedMeta = await run(dependencies.readMeta());
      } catch (error) {
        operationSignal.throwIfAborted();
        persistedMeta = null;
      }
    };
    const tasks = [
      run(dependencies.client.info("server")).then((value) => {
        serverInfo = value;
        return value;
      }),
      run(dependencies.client.info("memory")).then((value) => {
        memoryInfo = value;
        return value;
      }),
      run(dependencies.client.info("keyspace")).then((value) => {
        keyspaceInfo = value;
        return value;
      }),
      run(dependencies.client.dbsize()).then((value) => {
        dbsize = value;
        return value;
      }),
      deepInspectionPromise,
      readOptionalMeta().then(() => persistedMeta),
      run(dependencies.readRequiredCommands(operationSignal)).then((value) => {
        requiredCommands = value;
        return value;
      }),
      run(dependencies.readProjection(null)).then((value) => {
        projection = value;
        return value;
      })
    ] as const;
    inspectionTasks = tasks;
    const [
      currentServerInfo,
      currentMemoryInfo,
      currentKeyspaceInfo,
      currentDbsize,
      currentDeepInspection,
      currentPersistedMeta,
      currentRequiredCommands,
      currentProjection
    ] = await Promise.all(tasks);
    operationSignal.throwIfAborted();
    const memoryState = parseRedisMemoryState(currentMemoryInfo);
    const coordinator = dependencies.coordinatorStatus();
    const issues: string[] = [];
    if (!coordinator.readable) {
      issues.push(`统一图片缓存不可读：${coordinator.reason}`);
    }
    if (!currentPersistedMeta) {
      issues.push("统一图片缓存 meta 不存在或无法解析");
    }
    for (const command of currentRequiredCommands.missing) {
      issues.push(`Redis 缺少必需命令：${command}`);
    }
    if (currentPersistedMeta?.state !== "ready") {
      issues.push(
        `统一图片缓存状态不是 ready：${currentPersistedMeta?.state ?? "missing"}`
      );
    }
    if (!currentDeepInspection.complete) {
      issues.push(
        `Redis 深度扫描未完成：${currentDeepInspection.reason}`
      );
    } else if (currentPersistedMeta?.state === "ready") {
      const expectedCoreKeys = currentPersistedMeta.itemCount === 0
        ? READY_IMAGE_EMPTY_CORE_KEYS.length
        : READY_IMAGE_CORE_KEYS.length;
      const observedCoreKeys =
        currentDeepInspection.image_projection_usage.core.key_count;
      if (observedCoreKeys !== expectedCoreKeys) {
        issues.push(
          `统一图片缓存核心键数量异常：${observedCoreKeys}/${expectedCoreKeys}`
        );
      }
    }

    return {
      connection: {
        status: dependencies.client.status,
        configured_db: deploymentConfig.redis.db,
        redis_version: parseRedisInfo(
          currentServerInfo,
          new Set(["redis_version"])
        ).redis_version ?? "unknown",
        dbsize: currentDbsize,
        required_commands: currentRequiredCommands.commands,
        memory: {
          ...parseRedisInfo(currentMemoryInfo),
          used_memory_bytes: memoryState.usedMemory,
          used_memory_rss_bytes: memoryState.usedMemoryRss
        },
        keyspace: parseRedisInfo(currentKeyspaceInfo)
      },
      deep_inspection: currentDeepInspection,
      image_projection: currentProjection,
      issues
    };
  } catch (error) {
    if (signal?.aborted) {
      inspection.abort(abortSignalError(signal, "Redis inspection aborted"));
      await Promise.allSettled(inspectionTasks);
      throw abortSignalError(signal, "Redis inspection aborted");
    }
    if (!deadline.signal.aborted) {
      inspection.abort(
        error instanceof Error
          ? error
          : new Error("Redis inspection failed")
      );
      await Promise.allSettled(inspectionTasks);
      throw error;
    }
    await Promise.allSettled(inspectionTasks);
    deepInspection = deepInspectionPromise
      ? await deepInspectionPromise.catch(() => null)
      : null;
    return deadlineInspectionResponse({
      dependencies,
      serverInfo,
      memoryInfo,
      keyspaceInfo,
      dbsize,
      requiredCommands,
      projection,
      deepInspection,
      now: deepOptions.now
    });
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function parseRedisInfo(
  info: string,
  picked = new Set([
    "used_memory_human",
    "mem_fragmentation_ratio",
    "db0"
  ])
) {
  const result: Record<string, string> = {};
  for (const [key, value] of parseRedisInfoFields(info)) {
    if (picked.has(key)) result[key] = value;
  }
  return result;
}
