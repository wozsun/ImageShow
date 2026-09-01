import type { Redis, RedisOptions } from "ioredis";
import { redis } from "./client.ts";
import { runRequiredRedisCommand } from "../runtime-availability.ts";

const reserveRedisWindowsScript = `
local output = {}
local blocked = false
for index = 1, #KEYS do
  local argument = (index - 1) * 2
  local capacity = ARGV[argument + 1]
  local duration = ARGV[argument + 2]
  if blocked then
    output[#output + 1] = -1
    output[#output + 1] = 0
    output[#output + 1] = 0
    output[#output + 1] = duration
  else
    local increment = redis.call(
      'INCREX', KEYS[index], 'BYINT', '1', 'UBOUND', capacity,
      'EX', duration, 'ENX'
    )
    local ttl = redis.call('TTL', KEYS[index])
    local allowed = increment[2] == 1
    output[#output + 1] = allowed and 1 or 0
    output[#output + 1] = increment[1]
    output[#output + 1] = increment[2]
    output[#output + 1] = ttl
    if not allowed then blocked = true end
  end
end
return output`;

export const redisWindowScripts = Object.freeze({
  imageshowReserveWindows: {
    lua: reserveRedisWindowsScript,
    readOnly: false
  }
}) satisfies NonNullable<RedisOptions["scripts"]>;

export type RedisWindow = {
  key: string;
  capacity: number;
  windowSeconds: number;
};

export type RedisWindowReservation = {
  attempted: boolean;
  allowed: boolean;
  value: number;
  retryAfterSeconds: number;
};

type RedisWindowCommand = (
  ...arguments_: Array<string | number>
) => Promise<unknown>;

export type RedisWindowCommandClient = Readonly<{
  imageshowReserveWindows: RedisWindowCommand;
}>;

type RedisWindowRegistrar = Pick<Redis, "defineCommand"> &
  Partial<Pick<Redis, "options">>;
type RedisWindowCommandSource = RedisWindowCommandClient | RedisWindowRegistrar;

function redisWindowCandidate(client: object) {
  return client as Record<string, unknown>;
}

function hasRedisWindowCommand(
  client: RedisWindowCommandSource
): client is RedisWindowCommandClient {
  return typeof redisWindowCandidate(client).imageshowReserveWindows
    === "function";
}

function isRedisWindowRegistrar(
  client: RedisWindowCommandSource
): client is RedisWindowRegistrar {
  return typeof redisWindowCandidate(client).defineCommand === "function";
}

export function registerRedisWindowCommand(
  client: RedisWindowCommandSource
): RedisWindowCommandClient {
  if (!isRedisWindowRegistrar(client)) {
    if (hasRedisWindowCommand(client)) return client;
    throw new Error("Redis window client cannot register its command");
  }

  if (client.options) {
    client.options.scripts = {
      ...client.options.scripts,
      ...redisWindowScripts
    };
  }
  if (!hasRedisWindowCommand(client)) {
    client.defineCommand(
      "imageshowReserveWindows",
      redisWindowScripts.imageshowReserveWindows
    );
  }
  return client as unknown as RedisWindowCommandClient;
}

function integer(value: unknown, context: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Redis window script returned invalid ${context}`);
  }
  return parsed;
}

export async function reserveRedisWindowsCommand(
  client: RedisWindowCommandSource,
  windows: readonly RedisWindow[]
): Promise<RedisWindowReservation[]> {
  const commandClient = hasRedisWindowCommand(client)
    ? client
    : registerRedisWindowCommand(client);
  const raw = await commandClient.imageshowReserveWindows(
    String(windows.length),
    ...windows.map((window) => window.key),
    ...windows.flatMap((window) => [
      String(window.capacity),
      String(window.windowSeconds)
    ])
  );
  if (!Array.isArray(raw) || raw.length !== windows.length * 4) {
    throw new Error("Redis window script returned an invalid result count");
  }

  return windows.map((window, index) => {
    const offset = index * 4;
    const state = integer(raw[offset], "reservation state");
    const current = integer(raw[offset + 1], "reservation value");
    const increment = integer(raw[offset + 2], "reservation increment");
    const ttl = integer(raw[offset + 3], "reservation TTL");
    if (
      ![-1, 0, 1].includes(state)
      || current < 0
      || ![0, 1].includes(increment)
      || (state === 1) !== (increment === 1)
    ) {
      throw new Error("Redis window script returned inconsistent state");
    }
    return {
      attempted: state !== -1,
      allowed: state === 1,
      value: current,
      retryAfterSeconds: Math.max(1, ttl >= 0 ? ttl : window.windowSeconds)
    };
  });
}

function assertWindow(window: RedisWindow) {
  if (!window.key) throw new Error("Redis window key is required");
  if (!Number.isSafeInteger(window.capacity) || window.capacity < 1) {
    throw new Error("Redis window capacity must be a positive safe integer");
  }
  if (!Number.isSafeInteger(window.windowSeconds) || window.windowSeconds < 1) {
    throw new Error("Redis window duration must be a positive safe integer");
  }
}

/**
 * Reserves one token in each fixed window in one atomic Redis operation.
 * A rejected window short-circuits the remaining broader windows, preventing
 * one already-blocked identity from consuming a shared global allowance.
 * INCREX owns each cap and initial TTL; TTL reads never extend the window.
 */
async function reserveRedisWindowsUnchecked(
  windows: readonly RedisWindow[],
  client: RedisWindowCommandSource
): Promise<RedisWindowReservation[]> {
  return reserveRedisWindowsCommand(client, windows);
}

export function reserveRedisWindows(
  windows: readonly RedisWindow[],
  client: RedisWindowCommandSource = redis
): Promise<RedisWindowReservation[]> {
  if (!windows.length) return Promise.resolve([]);
  windows.forEach(assertWindow);
  return client === redis
    ? runRequiredRedisCommand(() => reserveRedisWindowsUnchecked(windows, client))
    : reserveRedisWindowsUnchecked(windows, client);
}
