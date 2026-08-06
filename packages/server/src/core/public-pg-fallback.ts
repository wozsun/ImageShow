import { AsyncLocalStorage } from "node:async_hooks";
import { appConfig } from "@imageshow/shared";
import {
  DatabaseError,
  type PoolClient,
  type QueryResult,
  type QueryResultRow
} from "pg";
import { ApiError } from "./api-error.ts";
import {
  databaseBackendQueryIsActive,
  pool,
  requestDatabaseBackendCancellation
} from "./db.ts";

export type PublicPgFallbackClass =
  keyof typeof appConfig.publicPgFallback.classes;

type AdmissionLease = {
  release(): void;
};

type QueueEntry = {
  kind: PublicPgFallbackClass;
  signal: AbortSignal;
  resolve: (lease: AdmissionLease) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort: () => void;
};

type PublicReadContext = {
  kind: PublicPgFallbackClass;
  operationAbort: AbortController;
  clientPromise: Promise<PoolClient> | null;
  clientCheckoutPending: boolean;
  client: PoolClient | null;
  clientReleased: boolean;
  pendingDatabaseWork: number;
  queryTail: Promise<void>;
  activeQueries: Set<Promise<unknown>>;
  coalescedLoads: Map<string, Promise<unknown>>;
  destructionConvergence: Promise<void> | null;
  admissionLease: AdmissionLease | null;
  executionTimer: ReturnType<typeof setTimeout> | null;
  terminalError: unknown;
  onRequestAbort: () => void;
};

class PublicPgFallbackError extends ApiError {
  readonly retryAfterSeconds = appConfig.publicPgFallback.retryAfterSeconds;
}

const classNames = Object.keys(
  appConfig.publicPgFallback.classes
) as PublicPgFallbackClass[];
const pending = Object.fromEntries(
  classNames.map((kind) => [kind, [] as QueueEntry[]])
) as Record<PublicPgFallbackClass, QueueEntry[]>;
const activeByClass = Object.fromEntries(
  classNames.map((kind) => [kind, 0])
) as Record<PublicPgFallbackClass, number>;
let activeTotal = 0;
let scheduling = false;
let nextClassIndex = 0;

const publicReadContext = new AsyncLocalStorage<PublicReadContext>();

function fallbackError(
  status: 429 | 503,
  code: string,
  message: string
) {
  return new PublicPgFallbackError(status, code, message);
}

export function publicPgFallbackWorkLimitExceeded(message: string) {
  return fallbackError(
    503,
    "public_pg_fallback_work_limit",
    message
  );
}

function signalError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Public PostgreSQL fallback aborted");
}

function raceWithSignal<T>(signal: AbortSignal, operation: Promise<T>) {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(signalError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signalError(signal));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });
}

function queuedCount() {
  return classNames.reduce((total, kind) => total + pending[kind].length, 0);
}

function classHasCapacity(kind: PublicPgFallbackClass) {
  return activeByClass[kind]
    < appConfig.publicPgFallback.classes[kind].concurrency;
}

function canActivate(kind: PublicPgFallbackClass) {
  return activeTotal < appConfig.publicPgFallback.totalConcurrency
    && classHasCapacity(kind);
}

function activate(kind: PublicPgFallbackClass): AdmissionLease {
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
}

function removeQueuedEntry(entry: QueueEntry) {
  const queue = pending[entry.kind];
  const index = queue.indexOf(entry);
  if (index < 0) return false;
  queue.splice(index, 1);
  clearTimeout(entry.timer);
  entry.signal.removeEventListener("abort", entry.onAbort);
  return true;
}

function nextRunnableClass() {
  // Lookup work is intentionally checked first. The remaining classes rotate
  // so sustained list/random/aggregate queues still make progress.
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
}

function scheduleQueuedWork() {
  if (scheduling) return;
  scheduling = true;
  try {
    while (activeTotal < appConfig.publicPgFallback.totalConcurrency) {
      const kind = nextRunnableClass();
      if (!kind) break;
      const entry = pending[kind].shift();
      if (!entry) continue;
      clearTimeout(entry.timer);
      entry.signal.removeEventListener("abort", entry.onAbort);
      if (entry.signal.aborted) {
        entry.reject(signalError(entry.signal));
        continue;
      }
      entry.resolve(activate(kind));
    }
  } finally {
    scheduling = false;
  }
}

function acquireAdmission(
  kind: PublicPgFallbackClass,
  signal: AbortSignal
): Promise<AdmissionLease> {
  signal.throwIfAborted();
  if (canActivate(kind) && pending[kind].length === 0) {
    return Promise.resolve(activate(kind));
  }
  if (queuedCount() >= appConfig.publicPgFallback.queueLimit) {
    return Promise.reject(fallbackError(
      429,
      "public_pg_fallback_queue_full",
      "Public PostgreSQL fallback queue is full"
    ));
  }
  return new Promise<AdmissionLease>((resolve, reject) => {
    const entry = {} as QueueEntry;
    entry.kind = kind;
    entry.signal = signal;
    entry.resolve = resolve;
    entry.reject = reject;
    entry.onAbort = () => {
      if (removeQueuedEntry(entry)) reject(signalError(signal));
    };
    entry.timer = setTimeout(() => {
      if (!removeQueuedEntry(entry)) return;
      reject(fallbackError(
        503,
        "public_pg_fallback_queue_timeout",
        "Public PostgreSQL fallback queue timed out"
      ));
    }, appConfig.publicPgFallback.queueTimeoutMs);
    entry.timer.unref();
    signal.addEventListener("abort", entry.onAbort, { once: true });
    pending[kind].push(entry);
    scheduleQueuedWork();
  });
}

function releaseAdmission(context: PublicReadContext) {
  context.admissionLease?.release();
  context.admissionLease = null;
}

function clearExecutionTimer(context: PublicReadContext) {
  if (!context.executionTimer) return;
  clearTimeout(context.executionTimer);
  context.executionTimer = null;
}

function releaseClient(context: PublicReadContext) {
  if (!context.client || context.clientReleased) return;
  context.clientReleased = true;
  context.client.release();
  releaseAdmission(context);
}

function clientProcessId(client: PoolClient) {
  const value = Number((client as PoolClient & { processID?: unknown }).processID);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function backendQueryHasStopped(processId: number) {
  const deadline = Date.now() + 2_000;
  do {
    if (!await databaseBackendQueryIsActive(processId)) return true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 20);
      timer.unref();
    });
  } while (Date.now() < deadline);
  return false;
}

function destroyClientAndConverge(context: PublicReadContext) {
  if (!context.client || context.clientReleased) return;
  const client = context.client;
  context.clientReleased = true;
  const processId = clientProcessId(client);
  context.destructionConvergence = (async () => {
    let cancellationConfirmed = false;
    let releasedToPool = false;
    const ended = new Promise<void>((resolve) => {
      client.once("end", resolve);
    });
    if (processId !== null) {
      try {
        await requestDatabaseBackendCancellation(processId);
        // The cancel request is now accepted by PostgreSQL. Destroy the
        // dedicated session so already-queued client queries cannot start.
        client.release(true);
        releasedToPool = true;
        cancellationConfirmed = await backendQueryHasStopped(processId);
        if (!cancellationConfirmed) {
          await requestDatabaseBackendCancellation(processId, true);
          cancellationConfirmed = await backendQueryHasStopped(processId);
        }
      } catch {
        // PostgreSQL itself may be unavailable. Destroying the dedicated
        // fallback session is then the only possible convergence boundary.
      }
    }
    if (!releasedToPool) {
      client.release(true);
    }
    // A rejected HTTP or node-postgres Promise is not proof that PostgreSQL
    // stopped executing the SQL. Keep the lease until the backend is known
    // inactive, or the dedicated session has emitted `end` and is therefore
    // actually destroyed.
    if (!cancellationConfirmed) {
      await ended;
    }
  })().finally(() => {
    releaseAdmission(context);
    context.destructionConvergence = null;
  });
  void context.destructionConvergence.catch(() => undefined);
}

function terminateContext(context: PublicReadContext, error: unknown) {
  if (!context.terminalError) context.terminalError = error;
  if (!context.operationAbort.signal.aborted) {
    context.operationAbort.abort(context.terminalError);
  }
  if (context.client) {
    // The HTTP promise may end now, but cancellation and permit release keep
    // converging independently against the PostgreSQL backend PID.
    destroyClientAndConverge(context);
  } else if (!context.clientCheckoutPending) {
    // No SQL can be running before a checkout starts. Once a checkout is in
    // flight, retain the lease until it settles so timed-out requests cannot
    // accumulate an unbounded pool wait queue behind the admission owner.
    releaseAdmission(context);
  }
}

async function ensurePublicClient(context: PublicReadContext) {
  if (context.client && !context.clientReleased) return context.client;
  if (context.terminalError) throw context.terminalError;
  context.clientPromise ??= (async () => {
    const lease = await acquireAdmission(
      context.kind,
      context.operationAbort.signal
    );
    if (context.operationAbort.signal.aborted) {
      lease.release();
      throw signalError(context.operationAbort.signal);
    }
    context.admissionLease = lease;
    const timeoutMs = appConfig.publicPgFallback.classes[
      context.kind
    ].executionTimeoutMs;
    context.executionTimer = setTimeout(() => {
      terminateContext(context, fallbackError(
        503,
        "public_pg_fallback_execution_timeout",
        "Public PostgreSQL fallback execution timed out"
      ));
    }, timeoutMs);
    context.executionTimer.unref();

    try {
      context.clientCheckoutPending = true;
      const checkout = pool.connect()
        .then((client) => {
          context.client = client;
          if (context.operationAbort.signal.aborted || context.terminalError) {
            destroyClientAndConverge(context);
            throw context.terminalError
              ?? signalError(context.operationAbort.signal);
          }
          return client;
        })
        .finally(() => {
          context.clientCheckoutPending = false;
          if (context.terminalError && !context.client) {
            releaseAdmission(context);
          }
        });
      return await raceWithSignal(context.operationAbort.signal, checkout);
    } catch (error) {
      if (!context.terminalError) {
        context.terminalError = fallbackError(
          503,
          "public_pg_fallback_unavailable",
          "PostgreSQL is unavailable for public fallback"
        );
      }
      if (!context.clientCheckoutPending && !context.client) {
        releaseAdmission(context);
      }
      throw context.terminalError ?? error;
    }
  })();
  return context.clientPromise;
}

function queryFailure(context: PublicReadContext, error: unknown) {
  if (context.terminalError) return context.terminalError;
  if (context.operationAbort.signal.aborted) {
    return signalError(context.operationAbort.signal);
  }
  if (error instanceof ApiError) return error;
  return fallbackError(
    503,
    "public_pg_fallback_query_failed",
    "Public PostgreSQL fallback query failed"
  );
}

function failPublicReadOperation(
  context: PublicReadContext,
  error: unknown
) {
  const failure = queryFailure(context, error);
  if (!(error instanceof ApiError) && !(error instanceof DatabaseError)) {
    // A transport/protocol rejection is not proof that PostgreSQL stopped the
    // statement. Destroy the dedicated session and retain admission until the
    // backend is inactive or the connection has emitted `end`.
    terminateContext(context, failure);
  }
  return failure;
}

function serializeClientWork<T>(
  context: PublicReadContext,
  work: () => Promise<T>
) {
  const current = context.queryTail.then(work);
  context.queryTail = current.then(
    () => undefined,
    () => undefined
  );
  return current;
}

function finishDatabaseWork(context: PublicReadContext) {
  context.pendingDatabaseWork -= 1;
  if (context.pendingDatabaseWork < 0) {
    throw new Error("Public PostgreSQL work accounting underflow");
  }
  if (context.pendingDatabaseWork > 0) return;

  // The admission permit and execution timeout cover only PostgreSQL work.
  // A public route may continue with slow storage or external-image I/O after
  // its lookup has completed; that later work must use its own timeout and
  // must not occupy database fallback capacity.
  clearExecutionTimer(context);
  if (
    context.terminalError
    || context.destructionConvergence
    || context.clientCheckoutPending
  ) {
    return;
  }
  if (context.activeQueries.size) {
    terminateContext(
      context,
      new Error("Public PostgreSQL query escaped its database scope")
    );
    return;
  }
  if (context.client && !context.clientReleased) {
    releaseClient(context);
  } else {
    releaseAdmission(context);
  }
  context.client = null;
  context.clientPromise = null;
  context.clientReleased = false;
}

export async function queryForPublicRead<
  Row extends QueryResultRow = QueryResultRow
>(text: string, values?: unknown[]): Promise<QueryResult<Row>> {
  const context = publicReadContext.getStore();
  if (!context) return pool.query<Row>(text, values);
  context.pendingDatabaseWork += 1;
  try {
    const client = await ensurePublicClient(context);
    return await serializeClientWork(context, async () => {
      context.operationAbort.signal.throwIfAborted();
      const query = client.query<Row>(text, values);
      context.activeQueries.add(query);
      void query.finally(() => {
        context.activeQueries.delete(query);
      }).catch(() => undefined);
      const result = await raceWithSignal(
        context.operationAbort.signal,
        query
      );
      context.operationAbort.signal.throwIfAborted();
      return result;
    });
  } catch (error) {
    throw failPublicReadOperation(context, error);
  } finally {
    finishDatabaseWork(context);
  }
}

export async function withPublicReadClient<T>(
  work: (client: PoolClient, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const context = publicReadContext.getStore();
  if (!context) {
    const client = await pool.connect();
    try {
      return await work(client, new AbortController().signal);
    } finally {
      client.release();
    }
  }
  context.pendingDatabaseWork += 1;
  try {
    const client = await ensurePublicClient(context);
    return await serializeClientWork(context, async () => {
      const value = await work(client, context.operationAbort.signal);
      context.operationAbort.signal.throwIfAborted();
      return value;
    });
  } catch (error) {
    throw failPublicReadOperation(context, error);
  } finally {
    finishDatabaseWork(context);
  }
}

export function publicReadUsesFallbackAdmission() {
  return publicReadContext.getStore() !== undefined;
}

export function runPublicReadBackgroundTask<T>(
  kind: PublicPgFallbackClass,
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  return publicReadContext.exit(() => runPublicReadRequest(kind, signal, work));
}

export function coalescePublicRead<T>(
  key: string,
  load: () => Promise<T>
): Promise<T> {
  const context = publicReadContext.getStore();
  if (!context) return load();
  const existing = context.coalescedLoads.get(key);
  if (existing) return existing as Promise<T>;
  const current = Promise.resolve().then(load);
  context.coalescedLoads.set(key, current);
  return current;
}

export async function runPublicReadRequest<T>(
  kind: PublicPgFallbackClass,
  requestSignal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (publicReadContext.getStore()) {
    return work(publicReadContext.getStore()!.operationAbort.signal);
  }
  const context: PublicReadContext = {
    kind,
    operationAbort: new AbortController(),
    clientPromise: null,
    clientCheckoutPending: false,
    client: null,
    clientReleased: false,
    pendingDatabaseWork: 0,
    queryTail: Promise.resolve(),
    activeQueries: new Set(),
    coalescedLoads: new Map(),
    destructionConvergence: null,
    admissionLease: null,
    executionTimer: null,
    terminalError: null,
    onRequestAbort: () => undefined
  };
  context.onRequestAbort = () => terminateContext(
    context,
    signalError(requestSignal)
  );
  if (requestSignal.aborted) context.onRequestAbort();
  else requestSignal.addEventListener("abort", context.onRequestAbort, {
    once: true
  });

  try {
    return await publicReadContext.run(context, async () => {
      const operation = Promise.resolve().then(() => (
        work(context.operationAbort.signal)
      ));
      const value = await raceWithSignal(
        context.operationAbort.signal,
        operation
      );
      context.operationAbort.signal.throwIfAborted();
      return value;
    });
  } finally {
    requestSignal.removeEventListener("abort", context.onRequestAbort);
    clearExecutionTimer(context);
    if (context.client && !context.clientReleased) {
      if (context.activeQueries.size) {
        terminateContext(
          context,
          new Error("Public PostgreSQL query escaped its request scope")
        );
      } else {
        releaseClient(context);
      }
    } else if (
      !context.destructionConvergence
      && !context.clientCheckoutPending
    ) {
      releaseAdmission(context);
    }
  }
}

export function getPublicPgFallbackAdmissionSnapshot() {
  return {
    active: activeTotal,
    active_by_class: { ...activeByClass },
    queued: queuedCount(),
    queued_by_class: Object.fromEntries(
      classNames.map((kind) => [kind, pending[kind].length])
    ) as Record<PublicPgFallbackClass, number>
  };
}
