import { setMaxListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export const neverAbortedSignal = new AbortController().signal;
// Many concurrent waits share this signal; it never fires, so its listener
// count is not a leak and must not trigger MaxListenersExceededWarning.
setMaxListeners(0, neverAbortedSignal);

/** Waits `delayMs`; cancellation rejects with the signal's own reason. */
export async function abortableDelay(delayMs: number, signal: AbortSignal) {
  signal.throwIfAborted();
  try {
    await delay(delayMs, undefined, { signal });
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}

export function abortSignalError(
  signal: AbortSignal,
  fallbackMessage = "Operation aborted"
) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(fallbackMessage);
}

export function raceWithAbortSignal<T>(
  signal: AbortSignal,
  operation: Promise<T>,
  fallbackMessage = "Operation aborted"
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(abortSignalError(signal, fallbackMessage));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", aborted);
    const aborted = () => {
      cleanup();
      reject(abortSignalError(signal, fallbackMessage));
    };
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}
