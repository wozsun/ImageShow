import type { TestContext } from "node:test";

type ScheduledTimer = {
  callback: (...arguments_: unknown[]) => void;
  arguments_: unknown[];
  dueAt: number;
};

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined
) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

/**
 * Installs a per-test browser clock without replacing Node's task queue.
 * Production code observes window timers and Date.now(), while test harness
 * flush helpers can still use real zero-delay tasks to settle React.
 */
export function installControlledClock(
  t: TestContext,
  window: Window,
  {
    initialNow = 1_000,
    minimumControlledDelayMs = 500,
    includeGlobalTimers = false,
    includeDateNow = true
  }: {
    initialNow?: number;
    minimumControlledDelayMs?: number;
    includeGlobalTimers?: boolean;
    includeDateNow?: boolean;
  } = {}
) {
  const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "setTimeout"
  );
  const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "clearTimeout"
  );
  const globalSetTimeoutDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "setTimeout"
  );
  const globalClearTimeoutDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "clearTimeout"
  );
  const dateNowDescriptor = Object.getOwnPropertyDescriptor(Date, "now");
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const timers = new Map<number, ScheduledTimer>();
  const nativeTimers = new Set<unknown>();
  let nextId = 0;
  let now = initialNow;

  const schedule = (
    callback: TimerHandler,
    delay = 0,
    ...arguments_: unknown[]
  ) => {
    if (typeof callback !== "function") {
      throw new TypeError("受控测试时钟只接受函数回调");
    }
    const normalizedDelay = Math.max(0, Number(delay) || 0);
    if (normalizedDelay < minimumControlledDelayMs) {
      let nativeId: unknown;
      nativeId = nativeSetTimeout(() => {
        nativeTimers.delete(nativeId);
        (callback as (...arguments_: unknown[]) => void)(...arguments_);
      }, normalizedDelay);
      nativeTimers.add(nativeId);
      return nativeId;
    }
    const id = ++nextId;
    timers.set(id, {
      callback: callback as (...arguments_: unknown[]) => void,
      arguments_,
      dueAt: now + normalizedDelay
    });
    return -id;
  };

  Object.defineProperty(window, "setTimeout", {
    configurable: true,
    writable: true,
    value: schedule
  });
  Object.defineProperty(window, "clearTimeout", {
    configurable: true,
    writable: true,
    value: (id: unknown) => {
      if (typeof id === "number" && id < 0) {
        timers.delete(-id);
        return;
      }
      nativeTimers.delete(id);
      nativeClearTimeout(id as number);
    }
  });
  if (includeGlobalTimers) {
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      writable: true,
      value: schedule
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      writable: true,
      value: (id: unknown) => {
        if (typeof id === "number" && id < 0) {
          timers.delete(-id);
          return;
        }
        nativeTimers.delete(id);
        nativeClearTimeout(id as number);
      }
    });
  }
  if (includeDateNow) {
    Object.defineProperty(Date, "now", {
      configurable: true,
      writable: true,
      value: () => now
    });
  }

  t.after(() => {
    timers.clear();
    for (const id of nativeTimers) nativeClearTimeout(id as number);
    nativeTimers.clear();
    restoreProperty(window, "setTimeout", setTimeoutDescriptor);
    restoreProperty(window, "clearTimeout", clearTimeoutDescriptor);
    if (includeGlobalTimers) {
      restoreProperty(
        globalThis,
        "setTimeout",
        globalSetTimeoutDescriptor
      );
      restoreProperty(
        globalThis,
        "clearTimeout",
        globalClearTimeoutDescriptor
      );
    }
    if (includeDateNow) restoreProperty(Date, "now", dateNowDescriptor);
  });

  return {
    now: () => now,
    pendingCount: () => timers.size,
    async advanceBy(durationMs: number) {
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        throw new RangeError("受控测试时钟只能向前推进有限时长");
      }
      // Let the action that just completed parse its response and schedule the
      // browser timer before inspecting the clock queue.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const target = now + durationMs;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((left, right) => (
            left[1].dueAt - right[1].dueAt || left[0] - right[0]
          ))[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.dueAt;
        timer.callback(...timer.arguments_);
        await Promise.resolve();
      }
      now = target;
      await Promise.resolve();
    }
  };
}
