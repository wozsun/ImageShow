import { logger } from "./logger.ts";
import {
  getRedisConnectionState,
  isRedisRequiredCommandsError,
  onRedisConnectionStateChange,
  validateRedisRequiredFeaturesAtCurrentEpoch,
  type RedisRequiredCommandCapabilities
} from "./redis-client.ts";

export type RedisOperationalState = Readonly<{
  available: boolean;
  connectionEpoch: number;
  reason: string;
  capabilities: RedisRequiredCommandCapabilities | null;
}>;

type RedisOperationalListener = (state: RedisOperationalState) => void;
type BusinessGateListener = () => void;

class RedisUnavailableError extends Error {
  readonly code = "redis_unavailable";

  constructor(cause?: unknown) {
    super("Redis unavailable", { cause });
    this.name = "redis_unavailable";
  }
}

let initializationComplete = false;
let businessGateOpened = false;
let redisState: RedisOperationalState = {
  available: false,
  connectionEpoch: 0,
  reason: "not_validated",
  capabilities: null
};
let probePromise: Promise<RedisRequiredCommandCapabilities> | null = null;
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let removeConnectionListener: (() => void) | null = null;
const redisListeners = new Set<RedisOperationalListener>();
const businessGateListeners = new Set<BusinessGateListener>();

function publishRedisState(next: RedisOperationalState) {
  const sameCapabilities = next.capabilities === redisState.capabilities || (
    next.capabilities !== null
    && redisState.capabilities !== null
    && next.capabilities.available === redisState.capabilities.available
    && next.capabilities.missing.join(",")
      === redisState.capabilities.missing.join(",")
  );
  if (
    next.available === redisState.available
    && next.connectionEpoch === redisState.connectionEpoch
    && next.reason === redisState.reason
    && sameCapabilities
  ) return;
  const previous = redisState;
  redisState = next;
  if (!next.available) {
    logger.warn("redis operational state degraded", {
      reason: next.reason,
      connection_epoch: next.connectionEpoch,
      missing_commands: next.capabilities?.missing ?? []
    });
  } else if (!previous.available) {
    logger.info("redis operational state ready", {
      connection_epoch: next.connectionEpoch
    });
  }
  for (const listener of redisListeners) listener(redisState);
}

function openBusinessGateIfReady() {
  if (
    businessGateOpened
    || !initializationComplete
    || !redisState.available
  ) return false;
  businessGateOpened = true;
  for (const listener of businessGateListeners) listener();
  businessGateListeners.clear();
  logger.info("business availability gate opened", {
    redis_connection_epoch: redisState.connectionEpoch
  });
  return true;
}

function markRedisUnavailable(
  reason: string,
  capabilities: RedisRequiredCommandCapabilities | null = null
) {
  const connection = getRedisConnectionState();
  publishRedisState({
    available: false,
    connectionEpoch: connection.ready ? connection.epoch : 0,
    reason,
    capabilities
  });
}

export function markRuntimeInitializationComplete() {
  initializationComplete = true;
  openBusinessGateIfReady();
}

export function runtimeInitializationIsComplete() {
  return initializationComplete;
}

export function businessAvailabilityGateIsOpen() {
  return businessGateOpened;
}

export function onBusinessAvailabilityGateOpen(listener: BusinessGateListener) {
  if (businessGateOpened) {
    queueMicrotask(listener);
    return () => undefined;
  }
  businessGateListeners.add(listener);
  return () => businessGateListeners.delete(listener);
}

export function getRedisOperationalState() {
  return redisState;
}

export function onRedisOperationalStateChange(
  listener: RedisOperationalListener
) {
  redisListeners.add(listener);
  return () => redisListeners.delete(listener);
}

function ensureRedisConnectionListener() {
  if (removeConnectionListener) return;
  removeConnectionListener = onRedisConnectionStateChange((connection) => {
    if (!connection.ready) {
      markRedisUnavailable("connection_unavailable");
      return;
    }
    void probeRedisOperationalState().catch(() => undefined);
  });
}

export function probeRedisOperationalState() {
  ensureRedisConnectionListener();
  probePromise ??= (async () => {
    try {
      const validation = await validateRedisRequiredFeaturesAtCurrentEpoch();
      const preparedConnection = getRedisConnectionState();
      if (
        !preparedConnection.ready
        || preparedConnection.epoch !== validation.connectionEpoch
      ) {
        throw new Error(
          "Redis connection changed during operational validation"
        );
      }
      publishRedisState({
        available: true,
        connectionEpoch: validation.connectionEpoch,
        reason: "ready",
        capabilities: validation.capabilities
      });
      openBusinessGateIfReady();
      return validation.capabilities;
    } catch (error) {
      markRedisUnavailable(
        isRedisRequiredCommandsError(error)
          ? "required_commands_missing"
          : "connection_unavailable",
        isRedisRequiredCommandsError(error) ? error.capabilities : null
      );
      throw error;
    }
  })().finally(() => {
    probePromise = null;
  });
  return probePromise;
}

export async function requireOperationalRedis() {
  const connection = getRedisConnectionState();
  if (
    redisState.available
    && connection.ready
    && redisState.connectionEpoch === connection.epoch
    && redisState.capabilities?.available
  ) return redisState.capabilities;
  try {
    return await probeRedisOperationalState();
  } catch (error) {
    throw new RedisUnavailableError(error);
  }
}

export async function runRequiredRedisCommand<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    markRedisUnavailable("command_failed");
    throw error instanceof RedisUnavailableError
      ? error
      : new RedisUnavailableError(error);
  }
}

export function startRedisOperationalMonitor(intervalMs = 5_000) {
  ensureRedisConnectionListener();
  if (!monitorTimer) {
    monitorTimer = setInterval(() => {
      void probeRedisOperationalState().catch(() => undefined);
    }, intervalMs);
    monitorTimer.unref();
  }
  void probeRedisOperationalState().catch(() => undefined);
}

export function stopRedisOperationalMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
  removeConnectionListener?.();
  removeConnectionListener = null;
}
