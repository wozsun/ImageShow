import { Redis } from "ioredis";
import { deploymentConfig } from "../config/deployment-config.ts";
import { abortSignalError, raceWithAbortSignal } from "./abort.ts";
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

async function waitForRedisProbe<T>(
  operation: Promise<T>,
  signal?: AbortSignal
) {
  return signal
    ? raceWithAbortSignal(signal, operation, "Redis probe aborted")
    : operation;
}

function throwIfRedisProbeAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw abortSignalError(signal, "Redis probe aborted");
  }
}

export async function pingRedis(signal?: AbortSignal) {
  throwIfRedisProbeAborted(signal);
  if (redis.status === "wait" || redis.status === "end") {
    redisConnectPromise ??= redis.connect().finally(() => {
      redisConnectPromise = null;
    });
    await waitForRedisProbe(redisConnectPromise, signal);
  }
  throwIfRedisProbeAborted(signal);
  if (redis.status !== "ready") {
    throw new Error(`Redis client is not ready (${redis.status})`);
  }
  await waitForRedisProbe(redis.ping(), signal);
  throwIfRedisProbeAborted(signal);
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

type RedisCommandProbe = Pick<Redis, "call" | "pipeline">;

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
  probe: () => Promise<boolean>,
  signal?: AbortSignal
) {
  try {
    return await probe();
  } catch (error) {
    if (signal?.aborted) {
      throw abortSignalError(signal, "Redis command probe aborted");
    }
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
  client: RedisCommandProbe = redis,
  signal?: AbortSignal
): Promise<RedisRequiredCommandCapabilities> {
  throwIfRedisProbeAborted(signal);
  const increx = await commandProbe(async () => {
    const reply = await waitForRedisProbe(
      client.call(
        "INCREX",
        REQUIRED_COMMAND_COUNTER_PROBE_KEY,
        "BYINT",
        "1",
        "UBOUND",
        "1",
        "EX",
        String(REQUIRED_COMMAND_PROBE_TTL_SECONDS),
        "ENX"
      ),
      signal
    );
    return Array.isArray(reply)
      && reply.length === 2
      && reply.every(isNonNegativeIntegerReply);
  }, signal);

  throwIfRedisProbeAborted(signal);
  // Queue creation, TTL, read probe and cleanup as one indivisible scheduling
  // stage. If the request is cancelled while Redis is executing it, no later
  // command is scheduled and either EXPIRE or UNLINK bounds the probe key.
  const pipeline = client.pipeline();
  pipeline.call(
    "ARRING",
    REQUIRED_COMMAND_ARRAY_PROBE_KEY,
    "1",
    "imageshow-required-command-probe"
  );
  pipeline.call(
    "EXPIRE",
    REQUIRED_COMMAND_ARRAY_PROBE_KEY,
    String(REQUIRED_COMMAND_PROBE_TTL_SECONDS)
  );
  pipeline.call(
    "ARLASTITEMS",
    REQUIRED_COMMAND_ARRAY_PROBE_KEY,
    "1",
    "REV"
  );
  pipeline.call(
    "UNLINK",
    REQUIRED_COMMAND_COUNTER_PROBE_KEY,
    REQUIRED_COMMAND_ARRAY_PROBE_KEY
  );
  const results = await waitForRedisProbe(pipeline.exec(), signal);
  throwIfRedisProbeAborted(signal);
  if (!results || results.length !== 4) {
    throw new Error("Redis required-command probe returned invalid results");
  }
  const [arringResult, expirationResult, arlastitemsResult, cleanupResult] =
    results;
  if (
    !arringResult
    || !expirationResult
    || !arlastitemsResult
    || !cleanupResult
  ) {
    throw new Error("Redis required-command probe returned incomplete results");
  }
  const [arringError, arringReply] = arringResult;
  const [expirationError, expirationReply] = expirationResult;
  const [arlastitemsError, arlastitemsReply] = arlastitemsResult;
  const [cleanupError] = cleanupResult;
  const arrayProbeCreated = !arringError
    && isNonNegativeIntegerReply(arringReply);
  const arrayProbeTtlApplied = !expirationError
    && Number(expirationReply) === 1;
  const cleanupSucceeded = !cleanupError;
  if (arrayProbeCreated && !arrayProbeTtlApplied && !cleanupSucceeded) {
    throw new Error("Redis required-command array probe could not set its TTL");
  }
  const commands = {
    INCREX: increx,
    ARRING: arrayProbeCreated && arrayProbeTtlApplied,
    ARLASTITEMS: !arlastitemsError
      && Array.isArray(arlastitemsReply)
      && arlastitemsReply.every((item) => typeof item === "string")
  } satisfies Record<RequiredRedisCommand, boolean>;
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
