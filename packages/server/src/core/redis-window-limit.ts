import type { Redis } from "ioredis";
import { redis } from "./redis-client.ts";

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

const reserveWindowsScript = `
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

function assertWindow(window: RedisWindow) {
  if (!window.key) throw new Error("Redis window key is required");
  if (!Number.isSafeInteger(window.capacity) || window.capacity < 1) {
    throw new Error("Redis window capacity must be a positive safe integer");
  }
  if (!Number.isSafeInteger(window.windowSeconds) || window.windowSeconds < 1) {
    throw new Error("Redis window duration must be a positive safe integer");
  }
}

function integer(value: unknown, context: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Redis window script returned invalid ${context}`);
  }
  return parsed;
}

/**
 * Reserves one token in each fixed window in one atomic Redis operation.
 * A rejected window short-circuits the remaining broader windows, preventing
 * one already-blocked identity from consuming a shared global allowance.
 * INCREX owns each cap and initial TTL; TTL reads never extend the window.
 */
export async function reserveRedisWindows(
  windows: readonly RedisWindow[],
  client: Redis = redis
): Promise<RedisWindowReservation[]> {
  if (!windows.length) return [];
  windows.forEach(assertWindow);

  const raw = await client.call(
    "EVAL",
    reserveWindowsScript,
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
