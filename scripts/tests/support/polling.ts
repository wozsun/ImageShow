import assert from "node:assert/strict";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";

/**
 * Re-reads every 20 ms until `settled` accepts the value or `timeoutMs`
 * elapses, then returns the last value for the caller to assert.
 */
export async function pollUntil<Value>(
  read: () => Promise<Value>,
  settled: (value: Value) => boolean,
  timeoutMs = 5_000
) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!settled(value) && Date.now() < deadline) {
    await delay(20);
    value = await read();
  }
  return value;
}

/** Fails unless in-process work satisfies `predicate` within 100 event-loop turns. */
export async function waitForTurns(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail(message);
}
