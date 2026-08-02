type ActiveRandomBuild<T = unknown> = {
  controller: AbortController;
  promise: Promise<T>;
};

class RandomBuildStoppingError extends Error {
  readonly code = "random_builds_stopping";

  constructor() {
    super("Random build coordinator is stopping");
    this.name = "RandomBuildStoppingError";
  }
}

/**
 * Owns every pool or filter build promise independently from its callers.
 * A caller may stop waiting, but the shared operation remains registered until
 * it really settles; process shutdown can therefore abort and drain it.
 */
class RandomBuildCoordinator {
  private accepting = true;
  private stopReason: unknown;
  private readonly active = new Map<string, ActiveRandomBuild>();

  run<T>(
    key: string,
    work: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal
  ): Promise<T> {
    callerSignal?.throwIfAborted();
    let record = this.active.get(key) as ActiveRandomBuild<T> | undefined;
    if (!record) {
      if (!this.accepting) {
        return Promise.reject(this.stopReason ?? new RandomBuildStoppingError());
      }
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => work(controller.signal));
      record = { controller, promise };
      this.active.set(key, record);
      promise.then(
        () => this.remove(key, record!),
        () => this.remove(key, record!)
      );
    }
    return waitForCaller(record.promise, callerSignal);
  }

  stop(reason: unknown = new RandomBuildStoppingError()) {
    if (!this.accepting) return;
    this.accepting = false;
    this.stopReason = reason;
    for (const record of this.active.values()) {
      record.controller.abort(reason);
    }
  }

  async drain() {
    while (this.active.size) {
      await Promise.allSettled(
        [...this.active.values()].map((record) => record.promise)
      );
    }
  }

  private remove(key: string, record: ActiveRandomBuild) {
    if (this.active.get(key) === record) this.active.delete(key);
  }
}

function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
    if (signal.aborted) aborted();
  });
}

const randomBuildCoordinator = new RandomBuildCoordinator();

export function runSharedRandomBuild<T>(
  key: string,
  work: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal
) {
  return randomBuildCoordinator.run(key, work, callerSignal);
}

export function stopRandomBuilds(reason?: unknown) {
  randomBuildCoordinator.stop(reason);
}

export function drainRandomBuilds() {
  return randomBuildCoordinator.drain();
}
