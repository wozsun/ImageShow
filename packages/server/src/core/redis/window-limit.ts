import {
  reserveRedisWindowsCommand,
  type RedisWindow,
  type RedisWindowCommandClient,
  type RedisWindowReservation
} from "./business-commands.ts";
import { redis } from "./client.ts";
import { runRequiredRedisCommand } from "../runtime-availability.ts";

export type { RedisWindow, RedisWindowReservation };

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
  client: RedisWindowCommandClient
): Promise<RedisWindowReservation[]> {
  return reserveRedisWindowsCommand(client, windows);
}

export function reserveRedisWindows(
  windows: readonly RedisWindow[],
  client: RedisWindowCommandClient = redis
): Promise<RedisWindowReservation[]> {
  if (!windows.length) return Promise.resolve([]);
  windows.forEach(assertWindow);
  return client === redis
    ? runRequiredRedisCommand(() => reserveRedisWindowsUnchecked(windows, client))
    : reserveRedisWindowsUnchecked(windows, client);
}
