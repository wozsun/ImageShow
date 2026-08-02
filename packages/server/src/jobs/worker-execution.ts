type WorkerExecutionCompletion<Result> =
  | { status: "fulfilled"; value: Result }
  | { status: "rejected"; error: unknown }
  | { status: "stopped"; reason: unknown };

type WorkerExecutionCoordinatorOptions<Job, Result> = {
  taskTimeoutMs: number;
  leaseRenewalIntervalMs: number;
  renewLease(job: Job): Promise<boolean>;
  execute(job: Job, signal: AbortSignal): Promise<Result>;
  settle(
    job: Job,
    completion: WorkerExecutionCompletion<Result>
  ): Promise<void>;
  onLeaseLost?(job: Job): void;
  onLeaseRenewalError?(job: Job, error: unknown): void;
};

type ActiveExecution<Job> = {
  job: Job;
  controller: AbortController;
  promise: Promise<void>;
  stopped: boolean;
};

class WorkerStoppingError extends Error {
  readonly code = "worker_stopping";

  constructor() {
    super("Worker is stopping");
    this.name = "WorkerStoppingError";
  }
}

class WorkerTaskTimeoutError extends Error {
  readonly code = "worker_task_timeout";

  constructor(timeoutMs: number) {
    super(`Background job exceeded its ${timeoutMs}ms execution deadline`);
    this.name = "WorkerTaskTimeoutError";
  }
}

class WorkerLeaseLostError extends Error {
  readonly code = "worker_lease_lost";

  constructor() {
    super("Background job lease ownership was lost");
    this.name = "WorkerLeaseLostError";
  }
}

class WorkerLeaseRenewalError extends Error {
  readonly code = "worker_lease_renewal_failed";

  constructor(cause: unknown) {
    super("Background job lease renewal failed", { cause });
    this.name = "WorkerLeaseRenewalError";
  }
}

/**
 * Owns the complete lifecycle of claimed work. A claim counts as active before
 * its handler can start, so stop/drain cannot miss a job that resolves from the
 * repository while shutdown is already in progress.
 */
export class WorkerExecutionCoordinator<Job, Result> {
  private accepting = true;
  private stopReason: unknown;
  private pendingClaims = 0;
  private readonly active = new Set<ActiveExecution<Job>>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly options: WorkerExecutionCoordinatorOptions<Job, Result>;

  constructor(options: WorkerExecutionCoordinatorOptions<Job, Result>) {
    this.options = options;
  }

  isAccepting() {
    return this.accepting;
  }

  start() {
    if (this.accepting) return;
    if (this.pendingClaims || this.active.size) {
      throw new Error("Cannot restart worker before its prior execution drained");
    }
    this.stopReason = undefined;
    this.accepting = true;
  }

  async claimAndRun(
    claim: () => Promise<Job | null | undefined>
  ): Promise<boolean> {
    if (!this.accepting) return false;
    this.pendingClaims += 1;

    let job: Job | null | undefined;
    try {
      job = await claim();
    } catch (error) {
      this.pendingClaims -= 1;
      this.notifyIdle();
      throw error;
    }
    if (!job) {
      this.pendingClaims -= 1;
      this.notifyIdle();
      return false;
    }

    const record: ActiveExecution<Job> = {
      job,
      controller: new AbortController(),
      promise: Promise.resolve(),
      stopped: false
    };
    record.promise = Promise.resolve()
      .then(() => this.run(record))
      .finally(() => {
        this.active.delete(record);
        this.notifyIdle();
      });
    this.active.add(record);

    // Registration and the claim counter handoff are synchronous. A stop that
    // happened while claim() was pending therefore either sees this record or
    // causes it to be aborted here before the handler's first microtask runs.
    if (!this.accepting) {
      record.stopped = true;
      record.controller.abort(this.stopReason ?? new WorkerStoppingError());
    }
    this.pendingClaims -= 1;
    this.notifyIdle();
    await record.promise;
    return true;
  }

  stop(reason: unknown = new WorkerStoppingError()) {
    if (this.accepting) {
      this.accepting = false;
      this.stopReason = reason;
    }
    const effectiveReason = this.stopReason ?? reason;
    for (const record of this.active) {
      if (!record.controller.signal.aborted) {
        record.stopped = true;
        record.controller.abort(effectiveReason);
      }
    }
    this.notifyIdle();
  }

  async drain(
    timeoutMs: number,
    additionalWork: readonly Promise<unknown>[] = []
  ): Promise<boolean> {
    const idle = this.waitForIdle();
    const completed = Promise.allSettled([
      idle.promise,
      ...additionalWork
    ]).then(() => true);
    if (timeoutMs <= 0) {
      idle.cancel();
      return this.isIdle() && additionalWork.length === 0;
    }

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([completed, deadline]);
    if (timer) clearTimeout(timer);
    idle.cancel();
    return result;
  }

  private isIdle() {
    return this.pendingClaims === 0 && this.active.size === 0;
  }

  private waitForIdle() {
    if (this.isIdle()) {
      return { promise: Promise.resolve(), cancel: () => undefined };
    }
    let resolveIdle!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveIdle = resolve;
      this.idleWaiters.add(resolve);
    });
    return {
      promise,
      cancel: () => this.idleWaiters.delete(resolveIdle)
    };
  }

  private notifyIdle() {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private abort(record: ActiveExecution<Job>, reason: unknown) {
    if (!record.controller.signal.aborted) {
      record.controller.abort(reason);
    }
  }

  private completionFromError(
    error: unknown,
    stopped: boolean
  ): WorkerExecutionCompletion<Result> {
    return stopped
      ? { status: "stopped", reason: error }
      : { status: "rejected", error };
  }

  private async run(record: ActiveExecution<Job>) {
    const { job, controller } = record;
    const { signal } = controller;
    let renewalStopped = false;
    let renewal = Promise.resolve();

    const queueRenewal = () => {
      renewal = renewal.then(async () => {
        if (renewalStopped || signal.aborted) return;
        try {
          const renewed = await this.options.renewLease(job);
          if (renewalStopped || signal.aborted) return;
          if (renewed) return;
          this.options.onLeaseLost?.(job);
          this.abort(record, new WorkerLeaseLostError());
        } catch (error) {
          if (renewalStopped || signal.aborted) return;
          this.options.onLeaseRenewalError?.(job, error);
          this.abort(record, new WorkerLeaseRenewalError(error));
        }
      });
    };

    const renewalTimer = setInterval(
      queueRenewal,
      Math.max(1, this.options.leaseRenewalIntervalMs)
    );
    renewalTimer.unref();
    const deadlineTimer = setTimeout(() => {
      this.abort(record, new WorkerTaskTimeoutError(this.options.taskTimeoutMs));
    }, Math.max(1, this.options.taskTimeoutMs));
    deadlineTimer.unref();

    let completion: WorkerExecutionCompletion<Result>;
    try {
      signal.throwIfAborted();
      const value = await this.options.execute(job, signal);
      signal.throwIfAborted();
      completion = { status: "fulfilled", value };
    } catch (error) {
      // Some APIs translate an AbortSignal into their own AbortError. The
      // controller still owns the authoritative cause: normal stop must be
      // requeued, while timeout and lease failures must remain failures.
      completion = this.completionFromError(
        signal.aborted ? signal.reason : error,
        record.stopped
      );
    } finally {
      renewalStopped = true;
      clearInterval(renewalTimer);
      await renewal;
      clearTimeout(deadlineTimer);
    }

    // A renewal already in flight may discover ownership loss after the
    // handler resolves. Never publish that late success as authoritative.
    if (completion.status === "fulfilled" && signal.aborted) {
      completion = this.completionFromError(signal.reason, record.stopped);
    }
    await this.options.settle(job, completion);
  }
}

export type { WorkerExecutionCompletion };
