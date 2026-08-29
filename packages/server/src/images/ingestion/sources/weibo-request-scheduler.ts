import { abortSignalError, raceWithAbortSignal } from "../../../core/abort.ts";
import { WeiboImportError } from "./weibo-types.ts";

type WeiboRequestDelayRange = {
  minDelaySeconds: number;
  maxDelaySeconds: number;
};

type WeiboScheduledRequest<Result> = (
  visitorCookie: string,
  signal: AbortSignal
) => Promise<Result>;

type WeiboSchedulerBatch = {
  requests: readonly WeiboScheduledRequest<unknown>[];
  results: PromiseSettledResult<unknown>[];
  nextIndex: number;
  signal: AbortSignal;
  settled: boolean;
  resolve: (results: PromiseSettledResult<unknown>[]) => void;
  reject: (error: unknown) => void;
  abort: () => void;
};

type WeiboRequestSchedulerOptions = {
  createVisitorIdentity: (signal: AbortSignal) => Promise<string>;
  delayRange: () => WeiboRequestDelayRange;
  random?: () => number;
  now?: () => number;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
};

const neverAbortedSignal = new AbortController().signal;

function waitForDelay(delayMs: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (delayMs <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      work();
    };
    const abort = () => finish(() => reject(abortSignalError(
      signal,
      "Weibo request wait aborted"
    )));
    const timer = setTimeout(() => finish(resolve), delayMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

class WeiboVisitorIdentity {
  private readonly createIdentity: (signal: AbortSignal) => Promise<string>;
  private identity: string | undefined;
  private creating: Promise<string> | undefined;
  private creatingSignal: AbortSignal | undefined;

  constructor(createIdentity: (signal: AbortSignal) => Promise<string>) {
    this.createIdentity = createIdentity;
  }

  async current(signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted();
      if (this.identity) return this.identity;

      if (!this.creating) {
        const creating = this.createIdentity(signal).then((identity) => {
          this.identity = identity;
          return identity;
        }).finally(() => {
          if (this.creating !== creating) return;
          this.creating = undefined;
          this.creatingSignal = undefined;
        });
        this.creating = creating;
        this.creatingSignal = signal;
      }

      const creating = this.creating;
      if (!this.creatingSignal?.aborted) {
        return raceWithAbortSignal(
          signal,
          creating,
          "Weibo visitor identity wait aborted"
        );
      }

      // A cancelled batch may leave its aborting handshake in flight briefly.
      // Let that one request settle before the next batch creates a new identity,
      // so cancellation cannot poison the next batch or create parallel visitors.
      try {
        await raceWithAbortSignal(
          signal,
          creating,
          "Weibo visitor identity wait aborted"
        );
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
  }

  invalidate(identity: string) {
    if (this.identity === identity) this.identity = undefined;
  }
}

class WeiboRequestScheduler {
  private readonly visitorIdentity: WeiboVisitorIdentity;
  private readonly delayRange: () => WeiboRequestDelayRange;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly wait: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly queue: WeiboSchedulerBatch[] = [];
  private draining = false;
  private lastStatusFinishedAt: number | undefined;

  constructor(options: WeiboRequestSchedulerOptions) {
    this.visitorIdentity = new WeiboVisitorIdentity(
      options.createVisitorIdentity
    );
    this.delayRange = options.delayRange;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? waitForDelay;
  }

  scheduleBatch<Result>(
    requests: readonly WeiboScheduledRequest<Result>[],
    signal: AbortSignal = neverAbortedSignal
  ): Promise<PromiseSettledResult<Result>[]> {
    signal.throwIfAborted();
    if (!requests.length) return Promise.resolve([]);

    return new Promise<PromiseSettledResult<Result>[]>((resolve, reject) => {
      const batch: WeiboSchedulerBatch = {
        requests,
        results: new Array(requests.length),
        nextIndex: 0,
        signal,
        settled: false,
        resolve: resolve as (results: PromiseSettledResult<unknown>[]) => void,
        reject,
        abort: () => {
          if (batch.settled) return;
          this.removeQueuedBatch(batch);
          this.rejectBatch(batch, abortSignalError(
            signal,
            "Weibo request batch aborted"
          ));
        }
      };
      signal.addEventListener("abort", batch.abort, { once: true });
      if (signal.aborted) {
        batch.abort();
        return;
      }
      this.queue.push(batch);
      void this.drain();
    });
  }

  private removeQueuedBatch(batch: WeiboSchedulerBatch) {
    const index = this.queue.indexOf(batch);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private resolveBatch(batch: WeiboSchedulerBatch) {
    if (batch.settled) return;
    batch.settled = true;
    batch.signal.removeEventListener("abort", batch.abort);
    batch.resolve(batch.results);
  }

  private rejectBatch(batch: WeiboSchedulerBatch, error: unknown) {
    if (batch.settled) return;
    batch.settled = true;
    batch.signal.removeEventListener("abort", batch.abort);
    batch.reject(error);
  }

  private sampledDelayMs() {
    const { minDelaySeconds, maxDelaySeconds } = this.delayRange();
    const minMs = Math.max(0, minDelaySeconds) * 1000;
    const maxMs = Math.max(minMs, maxDelaySeconds * 1000);
    const sample = Math.min(1, Math.max(0, this.random()));
    return minMs + ((maxMs - minMs) * sample);
  }

  private async waitBeforeNextStatus(signal: AbortSignal) {
    if (this.lastStatusFinishedAt === undefined) return;
    const sampledDelayMs = this.sampledDelayMs();
    const elapsedMs = Math.max(0, this.now() - this.lastStatusFinishedAt);
    await this.wait(Math.max(0, sampledDelayMs - elapsedMs), signal);
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const batch = this.queue.shift();
        if (!batch) return;
        if (batch.settled || batch.signal.aborted) {
          batch.abort();
          continue;
        }

        const requestIndex = batch.nextIndex;
        const request = batch.requests[requestIndex];
        batch.nextIndex += 1;
        let visitorIdentity: string;
        try {
          visitorIdentity = await this.visitorIdentity.current(batch.signal);
          await this.waitBeforeNextStatus(batch.signal);
          batch.signal.throwIfAborted();
        } catch (error) {
          if (!batch.settled) this.rejectBatch(batch, error);
          continue;
        }
        if (batch.settled) continue;

        let result: PromiseSettledResult<unknown> | undefined;
        try {
          result = {
            status: "fulfilled",
            value: await request(visitorIdentity, batch.signal)
          };
        } catch (error) {
          if (
            error instanceof WeiboImportError
            && error.code === "weibo_visitor_rejected"
          ) {
            this.visitorIdentity.invalidate(visitorIdentity);
          }
          if (
            !(error instanceof WeiboImportError)
            || error.code === "weibo_image_limit_exceeded"
          ) {
            this.rejectBatch(batch, error);
          } else {
            result = { status: "rejected", reason: error };
          }
        } finally {
          this.lastStatusFinishedAt = this.now();
        }

        if (batch.settled) continue;
        batch.results[requestIndex] = result!;
        if (batch.nextIndex < batch.requests.length) {
          this.queue.push(batch);
        } else {
          this.resolveBatch(batch);
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length) void this.drain();
    }
  }
}

export function createWeiboRequestScheduler(
  options: WeiboRequestSchedulerOptions
) {
  return new WeiboRequestScheduler(options);
}
