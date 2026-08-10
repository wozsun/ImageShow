import { appConfig } from "@imageshow/shared";
import { ApiError } from "./api-error.ts";
import { abortSignalError } from "./abort.ts";

export type PublicDatabaseFallbackClass =
  keyof typeof appConfig.publicPgFallback.classes;

export type PublicDatabaseAdmissionLease = {
  release(): void;
};

export type PublicDatabaseAdmission = {
  acquire(
    kind: PublicDatabaseFallbackClass,
    signal: AbortSignal
  ): Promise<PublicDatabaseAdmissionLease>;
  snapshot(): {
    active: number;
    active_by_class: Record<PublicDatabaseFallbackClass, number>;
    queued: number;
    queued_by_class: Record<PublicDatabaseFallbackClass, number>;
  };
};

export type PublicDatabaseAdmissionConfig = Pick<
  typeof appConfig.publicPgFallback,
  | "totalConcurrency"
  | "queueLimit"
  | "queueTimeoutMs"
  | "retryAfterSeconds"
  | "classes"
>;

type QueueEntry = {
  kind: PublicDatabaseFallbackClass;
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

/** @public Dependency-injection seam used by the local admission contract tests. */
export function createPublicDatabaseAdmission(
  config: PublicDatabaseAdmissionConfig = appConfig.publicPgFallback
): PublicDatabaseAdmission {
  const classNames = Object.keys(
    config.classes
  ) as PublicDatabaseFallbackClass[];
  const pending = Object.fromEntries(
    classNames.map((kind) => [kind, [] as QueueEntry[]])
  ) as Record<PublicDatabaseFallbackClass, QueueEntry[]>;
  const activeByClass = Object.fromEntries(
    classNames.map((kind) => [kind, 0])
  ) as Record<PublicDatabaseFallbackClass, number>;
  let activeTotal = 0;
  let scheduling = false;
  let nextClassIndex = 0;

  const queuedCount = () => classNames.reduce(
    (total, kind) => total + pending[kind].length,
    0
  );
  const classHasCapacity = (kind: PublicDatabaseFallbackClass) => (
    activeByClass[kind] < config.classes[kind].concurrency
  );
  const canActivate = (kind: PublicDatabaseFallbackClass) => (
    activeTotal < config.totalConcurrency && classHasCapacity(kind)
  );

  let scheduleQueuedWork = () => undefined;
  const activate = (
    kind: PublicDatabaseFallbackClass
  ): PublicDatabaseAdmissionLease => {
    activeTotal += 1;
    activeByClass[kind] += 1;
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        activeTotal -= 1;
        activeByClass[kind] -= 1;
        scheduleQueuedWork();
      }
    };
  };

  const removeQueuedEntry = (entry: QueueEntry) => {
    const queue = pending[entry.kind];
    const index = queue.indexOf(entry);
    if (index < 0) return false;
    queue.splice(index, 1);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.onAbort);
    return true;
  };

  const nextRunnableClass = () => {
    if (pending.lookup.length && canActivate("lookup")) return "lookup";
    for (let offset = 0; offset < classNames.length; offset += 1) {
      const index = (nextClassIndex + offset) % classNames.length;
      const kind = classNames[index]!;
      if (kind === "lookup" || !pending[kind].length || !canActivate(kind)) {
        continue;
      }
      nextClassIndex = (index + 1) % classNames.length;
      return kind;
    }
    return null;
  };

  scheduleQueuedWork = () => {
    if (scheduling) return;
    scheduling = true;
    try {
      while (activeTotal < config.totalConcurrency) {
        const kind = nextRunnableClass();
        if (!kind) break;
        const entry = pending[kind].shift();
        if (!entry) continue;
        clearTimeout(entry.timer);
        entry.signal.removeEventListener("abort", entry.onAbort);
        if (entry.signal.aborted) {
          entry.reject(abortSignalError(
            entry.signal,
            "Public PostgreSQL fallback aborted"
          ));
          continue;
        }
        entry.resolve(activate(kind));
      }
    } finally {
      scheduling = false;
    }
  };

  const acquire = (
    kind: PublicDatabaseFallbackClass,
    signal: AbortSignal
  ): Promise<PublicDatabaseAdmissionLease> => {
    signal.throwIfAborted();
    if (canActivate(kind) && pending[kind].length === 0) {
      return Promise.resolve(activate(kind));
    }
    if (queuedCount() >= config.queueLimit) {
      return Promise.reject(createPublicDatabaseFallbackError(
        429,
        "public_pg_fallback_queue_full",
        "Public PostgreSQL fallback queue is full",
        config.retryAfterSeconds
      ));
    }
    return new Promise<PublicDatabaseAdmissionLease>((resolve, reject) => {
      const entry = {} as QueueEntry;
      entry.kind = kind;
      entry.signal = signal;
      entry.resolve = resolve;
      entry.reject = reject;
      entry.onAbort = () => {
        if (removeQueuedEntry(entry)) {
          reject(abortSignalError(
            signal,
            "Public PostgreSQL fallback aborted"
          ));
        }
      };
      entry.timer = setTimeout(() => {
        if (!removeQueuedEntry(entry)) return;
        reject(createPublicDatabaseFallbackError(
          503,
          "public_pg_fallback_queue_timeout",
          "Public PostgreSQL fallback queue timed out",
          config.retryAfterSeconds
        ));
      }, config.queueTimeoutMs);
      entry.timer.unref();
      signal.addEventListener("abort", entry.onAbort, { once: true });
      pending[kind].push(entry);
      scheduleQueuedWork();
    });
  };

  return {
    acquire,
    snapshot: () => ({
      active: activeTotal,
      active_by_class: { ...activeByClass },
      queued: queuedCount(),
      queued_by_class: Object.fromEntries(
        classNames.map((kind) => [kind, pending[kind].length])
      ) as Record<PublicDatabaseFallbackClass, number>
    })
  };
}

export const publicDatabaseAdmission = createPublicDatabaseAdmission();

export function getPublicPgFallbackAdmissionSnapshot() {
  return publicDatabaseAdmission.snapshot();
}
