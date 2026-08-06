import { Redis } from "ioredis";
import { deploymentConfig } from "../config/deployment-config.ts";
import { logger } from "./logger.ts";

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

redis.on("error", (error) => {
  // Runtime availability owns the warning-level state transition. Keep the
  // client event observed so ioredis does not print an unstructured warning
  // for every reconnect attempt while Redis is down.
  logger.debug("redis client error", {
    error: error instanceof Error ? error.message : String(error)
  });
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
  if (redis.status !== "ready") {
    throw new Error(`Redis client is not ready (${redis.status})`);
  }
  await redis.ping();
}

const requiredRedisCommands = [
  "INCREX",
  "ARRING",
  "ARLASTITEMS"
] as const;
const REQUIRED_COMMAND_PROBE_TTL_SECONDS = 5;
const REQUIRED_COMMAND_COUNTER_PROBE_KEY =
  "imageshow:runtime:required-command-probe:counter";
const REQUIRED_COMMAND_ARRAY_PROBE_KEY =
  "imageshow:runtime:required-command-probe:array";

type RequiredRedisCommand = typeof requiredRedisCommands[number];

export type RedisRequiredCommandCapabilities = Readonly<{
  available: boolean;
  commands: Readonly<Record<RequiredRedisCommand, boolean>>;
  missing: readonly RequiredRedisCommand[];
}>;

type RedisCommandProbe = {
  call(command: string, ...args: string[]): Promise<unknown>;
};

export class RedisRequiredCommandsError extends Error {
  readonly code = "redis_required_commands_missing";
  readonly capabilities: RedisRequiredCommandCapabilities;

  constructor(capabilities: RedisRequiredCommandCapabilities) {
    super(`Redis is missing required commands: ${capabilities.missing.join(", ")}`);
    this.name = "RedisRequiredCommandsError";
    this.capabilities = capabilities;
  }
}

export function isRedisRequiredCommandsError(
  error: unknown
): error is RedisRequiredCommandsError {
  return error instanceof RedisRequiredCommandsError;
}

export function parseRedisInfoFields(info: string) {
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

function isNonNegativeIntegerReply(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0;
}

async function commandProbe(
  probe: () => Promise<boolean>
) {
  try {
    return await probe();
  } catch {
    return false;
  }
}

export function parseRedisMemoryState(info: string) {
  const fields = parseRedisInfoFields(info);
  return {
    usedMemory: safeMemoryBytes(fields.get("used_memory"), "used_memory"),
    usedMemoryRss: safeMemoryBytes(
      fields.get("used_memory_rss"),
      "used_memory_rss"
    )
  };
}

export async function readRequiredRedisCommandCapabilities(
  client: RedisCommandProbe = redis
): Promise<RedisRequiredCommandCapabilities> {
  let arrayProbeCreated = false;
  let arrayProbeTtlApplied = false;
  const commands = {
    INCREX: await commandProbe(async () => {
      const reply = await client.call(
        "INCREX",
        REQUIRED_COMMAND_COUNTER_PROBE_KEY,
        "BYINT",
        "1",
        "UBOUND",
        "1",
        "EX",
        String(REQUIRED_COMMAND_PROBE_TTL_SECONDS),
        "ENX"
      );
      return Array.isArray(reply)
        && reply.length === 2
        && reply.every(isNonNegativeIntegerReply);
    }),
    ARRING: await commandProbe(async () => {
      const reply = await client.call(
        "ARRING",
        REQUIRED_COMMAND_ARRAY_PROBE_KEY,
        "1",
        "imageshow-required-command-probe"
      );
      arrayProbeCreated = true;
      if (!isNonNegativeIntegerReply(reply)) return false;
      const expiration = await client.call(
        "EXPIRE",
        REQUIRED_COMMAND_ARRAY_PROBE_KEY,
        String(REQUIRED_COMMAND_PROBE_TTL_SECONDS)
      );
      arrayProbeTtlApplied = Number(expiration) === 1;
      return arrayProbeTtlApplied;
    }),
    ARLASTITEMS: await commandProbe(async () => {
      const reply = await client.call(
        "ARLASTITEMS",
        REQUIRED_COMMAND_ARRAY_PROBE_KEY,
        "1",
        "REV"
      );
      return Array.isArray(reply)
        && reply.every((item) => typeof item === "string");
    })
  } satisfies Record<RequiredRedisCommand, boolean>;
  // Both successful writes already carry a short TTL. UNLINK removes them
  // immediately; a restricted ACL may reject cleanup without turning the
  // fixed, bounded probe keys into persistent application state.
  let cleanupSucceeded = false;
  try {
    await client.call(
      "UNLINK",
      REQUIRED_COMMAND_COUNTER_PROBE_KEY,
      REQUIRED_COMMAND_ARRAY_PROBE_KEY
    );
    cleanupSucceeded = true;
  } catch {
    // The TTLs remain the cleanup boundary when immediate deletion is denied.
  }
  if (arrayProbeCreated && !arrayProbeTtlApplied && !cleanupSucceeded) {
    // ARRING succeeded but EXPIRE did not, so a cleanup failure would leave a
    // persistent probe. Treat that base-key lifecycle failure as unavailable.
    throw new Error("Redis required-command array probe could not set its TTL");
  }
  const missing = requiredRedisCommands.filter((command) => !commands[command]);
  return {
    available: missing.length === 0,
    commands,
    missing
  };
}

type RedisEpochValidationDependencies = {
  ping(): Promise<void>;
  connectionState(): RedisConnectionState;
  capabilities(): Promise<RedisRequiredCommandCapabilities>;
};

const defaultRedisEpochValidationDependencies:
  RedisEpochValidationDependencies = {
    ping: pingRedis,
    connectionState: getRedisConnectionState,
    capabilities: readRequiredRedisCommandCapabilities
  };

export async function validateRedisRequiredFeaturesAtCurrentEpoch(
  dependencies: RedisEpochValidationDependencies =
    defaultRedisEpochValidationDependencies
) {
  await dependencies.ping();
  const pinnedConnection = dependencies.connectionState();
  if (!pinnedConnection.ready) {
    throw new Error("Redis was not ready after the connection probe");
  }
  const capabilities = await dependencies.capabilities();
  if (!capabilities.available) {
    throw new RedisRequiredCommandsError(capabilities);
  }
  const after = dependencies.connectionState();
  if (!after.ready || pinnedConnection.epoch !== after.epoch) {
    throw new Error("Redis connection changed during capability validation");
  }
  return {
    capabilities,
    connectionEpoch: pinnedConnection.epoch
  };
}
