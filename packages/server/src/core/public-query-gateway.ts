import { AsyncLocalStorage } from "node:async_hooks";
import { appConfig } from "@imageshow/shared";
import {
  DatabaseError,
  type Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow
} from "pg";
import { ApiError } from "./api-error.ts";
import { abortSignalError, raceWithAbortSignal } from "./abort.ts";
import {
  databaseBackendQueryIsActive,
  pool,
  requestDatabaseBackendCancellation
} from "./database-pools.ts";
import {
  createPublicDatabaseFallbackError,
  publicDatabaseAdmission,
  type PublicDatabaseAdmission,
  type PublicDatabaseAdmissionLease,
  type PublicDatabaseFallbackClass
} from "./public-db-admission.ts";

type PublicReadContext = {
  kind: PublicDatabaseFallbackClass;
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
  admissionLease: PublicDatabaseAdmissionLease | null;
  executionTimer: ReturnType<typeof setTimeout> | null;
  terminalError: unknown;
  onRequestAbort: () => void;
};

type PublicQueryGatewayDependencies = {
  pool: Pick<Pool, "connect" | "query">;
  admission: PublicDatabaseAdmission;
  classes: typeof appConfig.publicPgFallback.classes;
  retryAfterSeconds: number;
  requestBackendCancellation: typeof requestDatabaseBackendCancellation;
  backendQueryIsActive: typeof databaseBackendQueryIsActive;
};

function publicPgAbortError(signal: AbortSignal) {
  return abortSignalError(signal, "Public PostgreSQL fallback aborted");
}

export function publicPgFallbackWorkLimitExceeded(message: string) {
  return createPublicDatabaseFallbackError(
    503,
    "public_pg_fallback_work_limit",
    message
  );
}

/** @public Dependency-injection seam used by the local gateway contract tests. */
export function createPublicQueryGateway(
  dependencies: PublicQueryGatewayDependencies
) {
  const publicReadContext = new AsyncLocalStorage<PublicReadContext>();
  const fallbackError = (
    status: 429 | 503,
    code: string,
    message: string
  ) => createPublicDatabaseFallbackError(
    status,
    code,
    message,
    dependencies.retryAfterSeconds
  );

  const releaseAdmission = (context: PublicReadContext) => {
    context.admissionLease?.release();
    context.admissionLease = null;
  };

  const clearExecutionTimer = (context: PublicReadContext) => {
    if (!context.executionTimer) return;
    clearTimeout(context.executionTimer);
    context.executionTimer = null;
  };

  const releaseClient = (context: PublicReadContext) => {
    if (!context.client || context.clientReleased) return;
    context.clientReleased = true;
    context.client.release();
    releaseAdmission(context);
  };

  const clientProcessId = (client: PoolClient) => {
    const value = Number(
      (client as PoolClient & { processID?: unknown }).processID
    );
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };

  const backendQueryHasStopped = async (processId: number) => {
    const deadline = Date.now() + 2_000;
    do {
      if (!await dependencies.backendQueryIsActive(processId)) return true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 20);
        timer.unref();
      });
    } while (Date.now() < deadline);
    return false;
  };

  const destroyClientAndConverge = (context: PublicReadContext) => {
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
          await dependencies.requestBackendCancellation(processId);
          // The cancel request is now accepted by PostgreSQL. Destroy the
          // dedicated session so already-queued client queries cannot start.
          client.release(true);
          releasedToPool = true;
          cancellationConfirmed = await backendQueryHasStopped(processId);
          if (!cancellationConfirmed) {
            await dependencies.requestBackendCancellation(processId, true);
            cancellationConfirmed = await backendQueryHasStopped(processId);
          }
        } catch {
          // PostgreSQL itself may be unavailable. Destroying the dedicated
          // fallback session is then the only possible convergence boundary.
        }
      }
      if (!releasedToPool) client.release(true);
      if (!cancellationConfirmed) await ended;
    })().finally(() => {
      releaseAdmission(context);
      context.destructionConvergence = null;
    });
    void context.destructionConvergence.catch(() => undefined);
  };

  const terminateContext = (
    context: PublicReadContext,
    error: unknown
  ) => {
    if (!context.terminalError) context.terminalError = error;
    if (!context.operationAbort.signal.aborted) {
      context.operationAbort.abort(context.terminalError);
    }
    if (context.client) {
      destroyClientAndConverge(context);
    } else if (!context.clientCheckoutPending) {
      releaseAdmission(context);
    }
  };

  const ensurePublicClient = async (context: PublicReadContext) => {
    if (context.client && !context.clientReleased) return context.client;
    if (context.terminalError) throw context.terminalError;
    context.clientPromise ??= (async () => {
      const lease = await dependencies.admission.acquire(
        context.kind,
        context.operationAbort.signal
      );
      if (context.operationAbort.signal.aborted) {
        lease.release();
        throw publicPgAbortError(context.operationAbort.signal);
      }
      context.admissionLease = lease;
      const timeoutMs = dependencies.classes[
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
        const checkout = dependencies.pool.connect()
          .then((client) => {
            context.client = client;
            if (context.operationAbort.signal.aborted || context.terminalError) {
              destroyClientAndConverge(context);
              throw context.terminalError
                ?? publicPgAbortError(context.operationAbort.signal);
            }
            return client;
          })
          .finally(() => {
            context.clientCheckoutPending = false;
            if (context.terminalError && !context.client) {
              releaseAdmission(context);
            }
          });
        return await raceWithAbortSignal(
          context.operationAbort.signal,
          checkout,
          "Public PostgreSQL fallback aborted"
        );
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
  };

  const queryFailure = (
    context: PublicReadContext,
    error: unknown
  ) => {
    if (context.terminalError) return context.terminalError;
    if (context.operationAbort.signal.aborted) {
      return publicPgAbortError(context.operationAbort.signal);
    }
    if (error instanceof ApiError) return error;
    return fallbackError(
      503,
      "public_pg_fallback_query_failed",
      "Public PostgreSQL fallback query failed"
    );
  };

  const failPublicReadOperation = (
    context: PublicReadContext,
    error: unknown
  ) => {
    const failure = queryFailure(context, error);
    if (!(error instanceof ApiError) && !(error instanceof DatabaseError)) {
      terminateContext(context, failure);
    }
    return failure;
  };

  const serializeClientWork = <T>(
    context: PublicReadContext,
    work: () => Promise<T>
  ) => {
    const current = context.queryTail.then(work);
    context.queryTail = current.then(
      () => undefined,
      () => undefined
    );
    return current;
  };

  const finishDatabaseWork = (context: PublicReadContext) => {
    context.pendingDatabaseWork -= 1;
    if (context.pendingDatabaseWork < 0) {
      throw new Error("Public PostgreSQL work accounting underflow");
    }
    if (context.pendingDatabaseWork > 0) return;

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
  };

  const queryForPublicRead = async <
    Row extends QueryResultRow = QueryResultRow
  >(text: string, values?: unknown[]): Promise<QueryResult<Row>> => {
    const context = publicReadContext.getStore();
    if (!context) return dependencies.pool.query<Row>(text, values);
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
        const result = await raceWithAbortSignal(
          context.operationAbort.signal,
          query,
          "Public PostgreSQL fallback aborted"
        );
        context.operationAbort.signal.throwIfAborted();
        return result;
      });
    } catch (error) {
      throw failPublicReadOperation(context, error);
    } finally {
      finishDatabaseWork(context);
    }
  };

  const withPublicReadClient = async <T>(
    work: (client: PoolClient, signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    const context = publicReadContext.getStore();
    if (!context) {
      const client = await dependencies.pool.connect();
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
  };

  const publicReadUsesFallbackAdmission = () => (
    publicReadContext.getStore() !== undefined
  );

  const coalescePublicRead = <T>(
    key: string,
    load: () => Promise<T>
  ): Promise<T> => {
    const context = publicReadContext.getStore();
    if (!context) return load();
    const existing = context.coalescedLoads.get(key);
    if (existing) return existing as Promise<T>;
    const current = Promise.resolve().then(load);
    context.coalescedLoads.set(key, current);
    return current;
  };

  const runPublicReadRequest = async <T>(
    kind: PublicDatabaseFallbackClass,
    requestSignal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    const existingContext = publicReadContext.getStore();
    if (existingContext) return work(existingContext.operationAbort.signal);
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
      publicPgAbortError(requestSignal)
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
        const value = await raceWithAbortSignal(
          context.operationAbort.signal,
          operation,
          "Public PostgreSQL fallback aborted"
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
  };

  const runPublicReadBackgroundTask = <T>(
    kind: PublicDatabaseFallbackClass,
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>
  ): Promise<T> => publicReadContext.exit(() => (
    runPublicReadRequest(kind, signal, work)
  ));

  return {
    queryForPublicRead,
    withPublicReadClient,
    publicReadUsesFallbackAdmission,
    runPublicReadBackgroundTask,
    coalescePublicRead,
    runPublicReadRequest
  };
}

const publicQueryGateway = createPublicQueryGateway({
  get pool() {
    return pool;
  },
  admission: publicDatabaseAdmission,
  classes: appConfig.publicPgFallback.classes,
  retryAfterSeconds: appConfig.publicPgFallback.retryAfterSeconds,
  requestBackendCancellation: requestDatabaseBackendCancellation,
  backendQueryIsActive: databaseBackendQueryIsActive
});

export const queryForPublicRead = publicQueryGateway.queryForPublicRead;
export const withPublicReadClient = publicQueryGateway.withPublicReadClient;
export const publicReadUsesFallbackAdmission =
  publicQueryGateway.publicReadUsesFallbackAdmission;
export const runPublicReadBackgroundTask =
  publicQueryGateway.runPublicReadBackgroundTask;
export const coalescePublicRead = publicQueryGateway.coalescePublicRead;
export const runPublicReadRequest = publicQueryGateway.runPublicReadRequest;
