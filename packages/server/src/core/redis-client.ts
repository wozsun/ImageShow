import { Redis } from "ioredis";
import { deploymentConfig } from "../config/deployment-config.ts";

const redisConfig = deploymentConfig.redis;

export const redis = new Redis({
  host: redisConfig.host,
  port: redisConfig.port,
  db: redisConfig.db,
  password: redisConfig.password,
  lazyConnect: true,
  connectTimeout: 5_000,
  commandTimeout: 5_000,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1
});

export type RedisConnectionState = Readonly<{
  ready: boolean;
  epoch: number;
}>;

type RedisConnectionStateListener = (state: RedisConnectionState) => void;

let redisConnectionReady = false;
let redisConnectionEpoch = 0;
const redisConnectionStateListeners = new Set<RedisConnectionStateListener>();

function redisConnectionState(): RedisConnectionState {
  return {
    ready: redisConnectionReady,
    epoch: redisConnectionEpoch
  };
}

function publishRedisConnectionState() {
  const state = redisConnectionState();
  for (const listener of redisConnectionStateListeners) listener(state);
}

redis.on("ready", () => {
  redisConnectionReady = true;
  redisConnectionEpoch += 1;
  publishRedisConnectionState();
});

function markRedisConnectionUnavailable() {
  if (!redisConnectionReady) return;
  redisConnectionReady = false;
  publishRedisConnectionState();
}

redis.on("close", markRedisConnectionUnavailable);
redis.on("end", markRedisConnectionUnavailable);

export function getRedisConnectionState() {
  return redisConnectionState();
}

export function onRedisConnectionStateChange(
  listener: RedisConnectionStateListener
) {
  redisConnectionStateListeners.add(listener);
  return () => redisConnectionStateListeners.delete(listener);
}

let redisConnectPromise: Promise<unknown> | null = null;

export async function pingRedis() {
  if (redis.status === "wait" || redis.status === "end") {
    redisConnectPromise ??= redis.connect().finally(() => {
      redisConnectPromise = null;
    });
    await redisConnectPromise;
  }
  await redis.ping();
}

const requiredRedisCommands = ["INCREX", "ARRING", "ARLASTITEMS"] as const;

function redisInfoFields(info: string) {
  const fields = new Map<string, string>();
  for (const rawLine of info.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return fields;
}

function safeMemoryBytes(raw: unknown, field: string) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Redis returned invalid ${field}`);
  }
  return value;
}

export async function readRedisMemoryState() {
  const fields = redisInfoFields(await redis.info("memory"));
  return {
    usedMemory: safeMemoryBytes(fields.get("used_memory"), "used_memory"),
    usedMemoryRss: safeMemoryBytes(
      fields.get("used_memory_rss"),
      "used_memory_rss"
    ),
    maxMemory: safeMemoryBytes(fields.get("maxmemory"), "maxmemory"),
    policy: fields.get("maxmemory_policy") ?? ""
  };
}

export function isRedisOutOfMemoryError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(?:^|\s)OOM command not allowed\b/i.test(message);
}

export async function assertRequiredRedisFeatures() {
  await pingRedis();
  const [commandInfo, memory] = await Promise.all([
    redis.call("COMMAND", "INFO", ...requiredRedisCommands),
    readRedisMemoryState()
  ]);
  if (
    !Array.isArray(commandInfo)
    || commandInfo.length !== requiredRedisCommands.length
    || commandInfo.some((entry) => !Array.isArray(entry))
  ) {
    throw new Error(
      "Redis must provide INCREX, ARRING, and ARLASTITEMS"
    );
  }
  if (memory.maxMemory <= 0 || memory.policy !== "noeviction") {
    throw new Error(
      "Redis must configure a positive maxmemory with maxmemory-policy noeviction"
    );
  }
}
