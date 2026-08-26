import { appConfig } from "@imageshow/shared";
import { ApiError } from "../api-error.ts";
import { abortSignalError } from "../abort.ts";

type PublicDatabaseAdmissionLease = {
  release(): void;
};

export type PublicDatabaseAdmission = {
  acquire(signal: AbortSignal): Promise<PublicDatabaseAdmissionLease>;
  snapshot(): { active: number; queued: number };
};

export type PublicDatabaseAdmissionConfig = Pick<
  typeof appConfig.publicPgFallback,
  | "totalConcurrency"
  | "queueLimit"
  | "queueTimeoutMs"
  | "retryAfterSeconds"
>;

type QueueEntry = {
  signal: AbortSignal;
  resolve: (lease: PublicDatabaseAdmissionLease) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort: () => void;
};

class PublicDatabaseFallbackError extends ApiError {
  readonly retryAfterSeconds: number;

  constructor(
    status: 429 | 503,
    code: string,
    message: string,
    retryAfterSeconds = appConfig.publicPgFallback.retryAfterSeconds
  ) {
    super(status, code, message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function createPublicDatabaseFallbackError(
  status: 429 | 503,
  code: string,
  message: string,
  retryAfterSeconds = appConfig.publicPgFallback.retryAfterSeconds
) {
  return new PublicDatabaseFallbackError(
    status,
    code,
    message,
    retryAfterSeconds
  );
}

/** @public Dependency-injection seam used by the local admission tests. */
export function createPublicDatabaseAdmission(
  config: PublicDatabaseAdmissionConfig = appConfig.publicPgFallback
): PublicDatabaseAdmission {
  const pending: QueueEntry[] = [];
  let active = 0;

  const activate = (): PublicDatabaseAdmissionLease => {
    active += 1;
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        active -= 1;
        schedule();
      }
    };
  };

  const remove = (entry: QueueEntry) => {
    const index = pending.indexOf(entry);
    if (index < 0) return false;
    pending.splice(index, 1);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.onAbort);
    return true;
  };

  const schedule = () => {
    while (active < config.totalConcurrency) {
      const entry = pending.shift();
      if (!entry) return;
      clearTimeout(entry.timer);
      entry.signal.removeEventListener("abort", entry.onAbort);
      if (entry.signal.aborted) {
        entry.reject(abortSignalError(
          entry.signal,
          "Public PostgreSQL fallback aborted"
        ));
        continue;
      }
      entry.resolve(activate());
    }
  };

  const acquire = (
    signal: AbortSignal
  ): Promise<PublicDatabaseAdmissionLease> => {
    signal.throwIfAborted();
    if (active < config.totalConcurrency && pending.length === 0) {
      return Promise.resolve(activate());
    }
    if (pending.length >= config.queueLimit) {
      return Promise.reject(createPublicDatabaseFallbackError(
        429,
        "public_pg_fallback_queue_full",
        "Public PostgreSQL fallback queue is full",
        config.retryAfterSeconds
      ));
    }
    return new Promise<PublicDatabaseAdmissionLease>((resolve, reject) => {
      const entry = {} as QueueEntry;
      entry.signal = signal;
      entry.resolve = resolve;
      entry.reject = reject;
      entry.onAbort = () => {
        if (remove(entry)) {
          reject(abortSignalError(
            signal,
            "Public PostgreSQL fallback aborted"
          ));
        }
      };
      entry.timer = setTimeout(() => {
        if (!remove(entry)) return;
        reject(createPublicDatabaseFallbackError(
          503,
          "public_pg_fallback_queue_timeout",
          "Public PostgreSQL fallback queue timed out",
          config.retryAfterSeconds
        ));
      }, config.queueTimeoutMs);
      entry.timer.unref();
      signal.addEventListener("abort", entry.onAbort, { once: true });
      pending.push(entry);
      schedule();
    });
  };

  return {
    acquire,
    snapshot: () => ({ active, queued: pending.length })
  };
}

export const publicDatabaseAdmission = createPublicDatabaseAdmission();

export function getPublicPgFallbackAdmissionSnapshot() {
  return publicDatabaseAdmission.snapshot();
}
