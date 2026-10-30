import assert from "node:assert/strict";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";

/**
 * Re-reads every 20 ms until `settled` accepts the value or five seconds
 * elapse, then returns the last value for the caller to assert.
 */
export async function pollUntil<Value>(
  read: () => Promise<Value>,
  settled: (value: Value) => boolean
) {
  const deadline = Date.now() + 5_000;
  let value = await read();
  while (!settled(value) && Date.now() < deadline) {
    await delay(20);
    value = await read();
  }
  return value;
}

/**
 * Lets React and timers advance one macrotask (`delayMs`) per turn, at least
 * once, until `predicate` holds; fails with `message` after `turns` turns.
 */
export async function settleReactUntil(
  predicate: () => boolean,
  message: string | (() => string),
  { turns = 100, delayMs = 0 }: { turns?: number; delayMs?: number } = {}
) {
  const { act } = await import("react");
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    });
    if (predicate()) return;
  }
  assert.fail(typeof message === "function" ? message() : message);
}

/** Fails unless in-process work satisfies `predicate` within 100 event-loop turns. */
export async function waitForTurns(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail(message);
}
