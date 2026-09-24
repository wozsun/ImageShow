import { raceWithAbortSignal } from "./abort.ts";

type SharedWork = {
  promise: Promise<unknown>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
};

const inFlight = new Map<string, SharedWork>();

/** A caller cancels its wait; shared work is cancelled when no callers remain. */
export async function coalesce<T>(
  key: string,
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  let shared = inFlight.get(key);
  if (!shared) {
    const controller = new AbortController();
    const entry: SharedWork = {
      controller,
      waiters: 0,
      settled: false,
      promise: Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return work(controller.signal);
        })
        .finally(() => {
          entry.settled = true;
          if (inFlight.get(key) === entry) inFlight.delete(key);
        })
    };
    inFlight.set(key, entry);
    shared = entry;
  }

  shared.waiters += 1;
  try {
    return (await (signal ? raceWithAbortSignal(signal, shared.promise) : shared.promise)) as T;
  } finally {
    shared.waiters -= 1;
    if (shared.waiters === 0 && !shared.settled) {
      if (inFlight.get(key) === shared) inFlight.delete(key);
      shared.controller.abort(new Error("Shared work has no remaining callers"));
    }
  }
}
