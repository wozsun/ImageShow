/**
 * The full public site and the admin need these natively: Chrome / Edge 119,
 * Firefox 124, Safari 17.4. Older browsers only get the gallery; the shims
 * below fill the gaps it and the shared code meet there. Support is decided by
 * capability, never by user agent.
 */
export const supportsFullSite = typeof Promise.withResolvers === "function"
  && typeof AbortSignal.any === "function";

function provide<T extends object, K extends keyof T>(target: T, name: K, value: T[K]) {
  if (typeof target[name] === "function") return;
  Object.defineProperty(target, name, { value, writable: true, configurable: true });
}

// Each shim goes once no supported browser lacks the native method.
provide(Promise, "withResolvers", function withResolvers<T>(): PromiseWithResolvers<T> {
  let resolve!: PromiseWithResolvers<T>["resolve"];
  let reject!: PromiseWithResolvers<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
});

// Without weak references the listeners stay on the sources until one of them
// aborts; callers combine per-request signals or ones bounded by a timeout.
provide(AbortSignal, "any", (signals: AbortSignal[]) => {
  const controller = new AbortController();
  const listeners = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => {
      controller.abort(signal.reason);
      listeners.abort();
    }, { once: true, signal: listeners.signal });
  }
  if (controller.signal.aborted) listeners.abort();
  return controller.signal;
});

// Native since Chrome / Edge 140, Firefox 133 and Safari 18.2, later than the full support range.
provide(Uint8Array.prototype, "toHex", function toHex(this: Uint8Array) {
  return Array.from(this, (byte) => byte.toString(16).padStart(2, "0")).join("");
});
