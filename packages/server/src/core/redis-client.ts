import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { deploymentConfig } from "../config/deployment-config.ts";
import { abortSignalError, raceWithAbortSignal } from "./abort.ts";
import { logger } from "./logger.ts";
import {
  parseRedisDeleteIfEqualReply,
  parseRedisSetIfEqualReply
} from "./redis-conditional-string.ts";

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
  "ARLASTITEMS",
  "SET_IFEQ_KEEPTTL",
  "DELEX_IFEQ"
] as const;
const REQUIRED_COMMAND_PROBE_TTL_SECONDS = 5;
const REQUIRED_COMMAND_PROBE_TTL_MILLISECONDS =
  REQUIRED_COMMAND_PROBE_TTL_SECONDS * 1_000;

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

function requiredCommandProbeKeys() {
  const namespace = `imageshow:runtime:required-command-probe:${randomUUID()}`;
  return {
    counter: `${namespace}:counter`,
    array: `${namespace}:array`,
    conditionalSet: `${namespace}:conditional-set`,
    conditionalSetMissing: `${namespace}:conditional-set-missing`,
    conditionalDelete: `${namespace}:conditional-delete`,
    conditionalDeleteMissing: `${namespace}:conditional-delete-missing`
  };
}

type RedisPipelineResult = [Error | null, unknown];

function requiredPipelineResult(
  results: RedisPipelineResult[],
  index: number
) {
  const result = results[index];
  if (!result) {
    throw new Error("Redis required-command probe returned incomplete results");
  }
  return result;
}

function validPipelineReply(
  result: RedisPipelineResult,
  validate: (reply: unknown) => boolean
) {
  if (result[0]) return false;
  try {
    return validate(result[1]);
  } catch {
    return false;
  }
}

function positiveProbeTtl(reply: unknown) {
  return typeof reply === "number"
    && Number.isSafeInteger(reply)
    && reply > 0
    && reply <= REQUIRED_COMMAND_PROBE_TTL_MILLISECONDS
    ? reply
    : null;
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
  const probeKeys = requiredCommandProbeKeys();
  const increx = await commandProbe(async () => {
    const reply = await waitForRedisProbe(
      client.call(
        "INCREX",
        probeKeys.counter,
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
    probeKeys.array,
    "1",
    "imageshow-required-command-probe"
  );
  pipeline.call(
    "EXPIRE",
    probeKeys.array,
    String(REQUIRED_COMMAND_PROBE_TTL_SECONDS)
  );
  pipeline.call(
    "ARLASTITEMS",
    probeKeys.array,
    "1",
    "REV"
  );
  pipeline.call(
    "SET",
    probeKeys.conditionalSet,
    "before",
    "EX",
    String(REQUIRED_COMMAND_PROBE_TTL_SECONDS)
  );
  pipeline.call("PTTL", probeKeys.conditionalSet);
  pipeline.call(
    "SET",
    probeKeys.conditionalSet,
    "after",
    "IFEQ",
    "before",
    "KEEPTTL"
  );
  pipeline.call("PTTL", probeKeys.conditionalSet);
  pipeline.call(
    "SET",
    probeKeys.conditionalSet,
    "unexpected",
    "IFEQ",
    "before",
    "KEEPTTL"
  );
  pipeline.call("GET", probeKeys.conditionalSet);
  pipeline.call(
    "SET",
    probeKeys.conditionalSetMissing,
    "unexpected",
    "IFEQ",
    "missing",
    "KEEPTTL"
  );
  pipeline.call("EXISTS", probeKeys.conditionalSetMissing);
  pipeline.call(
    "SET",
    probeKeys.conditionalDelete,
    "owned",
    "EX",
    String(REQUIRED_COMMAND_PROBE_TTL_SECONDS)
  );
  pipeline.call(
    "DELEX",
    probeKeys.conditionalDelete,
    "IFEQ",
    "other"
  );
  pipeline.call("GET", probeKeys.conditionalDelete);
  pipeline.call(
    "DELEX",
    probeKeys.conditionalDelete,
    "IFEQ",
    "owned"
  );
  pipeline.call("EXISTS", probeKeys.conditionalDelete);
  pipeline.call(
    "DELEX",
    probeKeys.conditionalDeleteMissing,
    "IFEQ",
    "missing"
  );
  pipeline.call(
    "UNLINK",
    ...Object.values(probeKeys)
  );
  const results = await waitForRedisProbe(pipeline.exec(), signal);
  throwIfRedisProbeAborted(signal);
  if (!results || results.length !== 18) {
    throw new Error("Redis required-command probe returned invalid results");
  }
  const arringResult = requiredPipelineResult(results, 0);
  const expirationResult = requiredPipelineResult(results, 1);
  const arlastitemsResult = requiredPipelineResult(results, 2);
  const conditionalSetSeedResult = requiredPipelineResult(results, 3);
  const conditionalSetInitialTtlResult = requiredPipelineResult(results, 4);
  const conditionalSetSuccessResult = requiredPipelineResult(results, 5);
  const conditionalSetKeptTtlResult = requiredPipelineResult(results, 6);
  const conditionalSetFailureResult = requiredPipelineResult(results, 7);
  const conditionalSetValueResult = requiredPipelineResult(results, 8);
  const conditionalSetMissingResult = requiredPipelineResult(results, 9);
  const conditionalSetMissingExistsResult = requiredPipelineResult(results, 10);
  const conditionalDeleteSeedResult = requiredPipelineResult(results, 11);
  const conditionalDeleteFailureResult = requiredPipelineResult(results, 12);
  const conditionalDeleteValueResult = requiredPipelineResult(results, 13);
  const conditionalDeleteSuccessResult = requiredPipelineResult(results, 14);
  const conditionalDeleteExistsResult = requiredPipelineResult(results, 15);
  const conditionalDeleteMissingResult = requiredPipelineResult(results, 16);
  const cleanupResult = requiredPipelineResult(results, 17);
  const [arringError, arringReply] = arringResult;
  const [expirationError, expirationReply] = expirationResult;
  const [arlastitemsError, arlastitemsReply] = arlastitemsResult;
  const [cleanupError, cleanupReply] = cleanupResult;
  const arrayProbeCreated = !arringError
    && isNonNegativeIntegerReply(arringReply);
  const arrayProbeTtlApplied = !expirationError
    && Number(expirationReply) === 1;
  const cleanupSucceeded = !cleanupError
    && isNonNegativeIntegerReply(cleanupReply);
  if (arrayProbeCreated && !arrayProbeTtlApplied && !cleanupSucceeded) {
    throw new Error("Redis required-command array probe could not set its TTL");
  }
  const initialSetTtl = conditionalSetInitialTtlResult[0]
    ? null
    : positiveProbeTtl(conditionalSetInitialTtlResult[1]);
  const keptSetTtl = conditionalSetKeptTtlResult[0]
    ? null
    : positiveProbeTtl(conditionalSetKeptTtlResult[1]);
  const setIfEqualKeepingTtl = validPipelineReply(
    conditionalSetSeedResult,
    (reply) => reply === "OK"
  ) && initialSetTtl !== null
    && validPipelineReply(
      conditionalSetSuccessResult,
      (reply) => parseRedisSetIfEqualReply(reply)
    )
    && keptSetTtl !== null
    && keptSetTtl <= initialSetTtl
    && validPipelineReply(
      conditionalSetFailureResult,
      (reply) => !parseRedisSetIfEqualReply(reply)
    )
    && validPipelineReply(
      conditionalSetValueResult,
      (reply) => reply === "after"
    )
    && validPipelineReply(
      conditionalSetMissingResult,
      (reply) => !parseRedisSetIfEqualReply(reply)
    )
    && validPipelineReply(
      conditionalSetMissingExistsResult,
      (reply) => Number(reply) === 0
    );
  const deleteIfEqual = validPipelineReply(
    conditionalDeleteSeedResult,
    (reply) => reply === "OK"
  ) && validPipelineReply(
    conditionalDeleteFailureResult,
    (reply) => !parseRedisDeleteIfEqualReply(reply)
  ) && validPipelineReply(
    conditionalDeleteValueResult,
    (reply) => reply === "owned"
  ) && validPipelineReply(
    conditionalDeleteSuccessResult,
    (reply) => parseRedisDeleteIfEqualReply(reply)
  ) && validPipelineReply(
    conditionalDeleteExistsResult,
    (reply) => Number(reply) === 0
  ) && validPipelineReply(
    conditionalDeleteMissingResult,
    (reply) => !parseRedisDeleteIfEqualReply(reply)
  );
  const commands = {
    INCREX: increx,
    ARRING: arrayProbeCreated && arrayProbeTtlApplied,
    ARLASTITEMS: !arlastitemsError
      && Array.isArray(arlastitemsReply)
      && arlastitemsReply.every((item) => typeof item === "string"),
    SET_IFEQ_KEEPTTL: setIfEqualKeepingTtl,
    DELEX_IFEQ: deleteIfEqual
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
