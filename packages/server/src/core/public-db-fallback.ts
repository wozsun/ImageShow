import { appConfig } from "@imageshow/shared";
import type { Pool, PoolClient } from "pg";
import { ApiError } from "./api-error.ts";
import { abortSignalError, raceWithAbortSignal } from "./abort.ts";
import { pool, type DatabaseReader } from "./database-pools.ts";
import { createPublicDatabaseFallbackError, publicDatabaseAdmission,
  type PublicDatabaseAdmission } from "./public-db-admission.ts";

export type PublicDatabaseReadAccess = { reader?: DatabaseReader };

type PublicDatabaseReadScopeDependencies = {
  pool: Pick<Pool, "connect">;
  admission: PublicDatabaseAdmission;
  executionTimeoutMs: number;
  retryAfterSeconds: number;
};

export function publicPgFallbackWorkLimitExceeded(message: string) {
  return createPublicDatabaseFallbackError(
    503, "public_pg_fallback_work_limit", message
  );
}

/** @public Dependency-injection seam used by local resource-release tests. */
export function createPublicDatabaseReadScope(
  dependencies: PublicDatabaseReadScopeDependencies
) {
  const fallbackError = (code: string, message: string) => (
    createPublicDatabaseFallbackError(
      503,
      code,
      message,
      dependencies.retryAfterSeconds
    )
  );

  return async <T>(
    requestSignal: AbortSignal,
    work: (access: { reader: DatabaseReader }, signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    requestSignal.throwIfAborted();
    const operationAbort = new AbortController();
    const onRequestAbort = () => operationAbort.abort(
      abortSignalError(requestSignal, "Public PostgreSQL fallback aborted")
    );
    requestSignal.addEventListener("abort", onRequestAbort, { once: true });

    let lease: Awaited<ReturnType<PublicDatabaseAdmission["acquire"]>> | null = null;
    let client: PoolClient | null = null;
    let clientPromise: Promise<PoolClient> | null = null;
    let checkoutPromise: Promise<PoolClient> | null = null;
    let destroyClient = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let scopeClosed = false;
    let activeQueries = 0;
    const closedError = () => operationAbort.signal.aborted
      ? abortSignalError(operationAbort.signal)
      : new Error("Public PostgreSQL read scope is closed");

    const retainLeaseForPendingCheckout = () => {
      if (client || !checkoutPromise || !lease) return;
      const heldLease = lease;
      lease = null;
      void checkoutPromise.then(
        (lateClient) => lateClient.release(true),
        () => undefined
      ).finally(() => heldLease.release());
    };

    const checkoutClient = async () => {
      if (client) return client;
      if (clientPromise) return clientPromise;
      if (scopeClosed) throw closedError();
      clientPromise = (async () => {
        lease = await dependencies.admission.acquire(operationAbort.signal);
        if (scopeClosed || operationAbort.signal.aborted) {
          const acquiredLease = lease;
          lease = null;
          acquiredLease.release();
          throw abortSignalError(operationAbort.signal);
        }
        timer = setTimeout(() => operationAbort.abort(fallbackError(
          "public_pg_fallback_execution_timeout",
          "Public PostgreSQL fallback execution timed out"
        )), dependencies.executionTimeoutMs);
        timer.unref();

        checkoutPromise = Promise.resolve().then(() => dependencies.pool.connect());
        try {
          client = await raceWithAbortSignal(
            operationAbort.signal,
            checkoutPromise,
            "Public PostgreSQL fallback aborted"
          );
          return client;
        } catch (error) {
          retainLeaseForPendingCheckout();
          if (operationAbort.signal.aborted) {
            throw abortSignalError(operationAbort.signal);
          }
          throw fallbackError(
            "public_pg_fallback_unavailable",
            "PostgreSQL is unavailable for public fallback"
          );
        }
      })();
      return clientPromise;
    };

    const reader: DatabaseReader = {
      query: ((...args: never[]) => {
        if (scopeClosed) return Promise.reject(closedError());
        activeQueries += 1;
        return checkoutClient()
          .then((activeClient) => {
            operationAbort.signal.throwIfAborted();
            return Reflect.apply(activeClient.query, activeClient, args);
          })
          .catch((error) => {
            if (operationAbort.signal.aborted) {
              throw abortSignalError(operationAbort.signal);
            }
            if (error instanceof ApiError) throw error;
            destroyClient = true;
            throw fallbackError(
              "public_pg_fallback_query_failed",
              "Public PostgreSQL fallback query failed"
            );
          })
          .finally(() => {
            activeQueries -= 1;
          });
      }) as DatabaseReader["query"]
    };

    const operation = Promise.resolve().then(() => work(
      { reader },
      operationAbort.signal
    ));
    try {
      const value = await raceWithAbortSignal(operationAbort.signal, operation);
      operationAbort.signal.throwIfAborted();
      return value;
    } catch (error) {
      void operation.catch(() => undefined);
      if (operationAbort.signal.aborted) {
        destroyClient = true;
        throw abortSignalError(operationAbort.signal);
      }
      throw error;
    } finally {
      scopeClosed = true;
      if (activeQueries > 0 && !operationAbort.signal.aborted) {
        operationAbort.abort(new Error(
          "Public PostgreSQL read scope closed with pending work"
        ));
      }
      requestSignal.removeEventListener("abort", onRequestAbort);
      if (timer) clearTimeout(timer);
      if (activeQueries > 0) destroyClient = true;
      retainLeaseForPendingCheckout();
      const checkedOutClient = client as PoolClient | null;
      const heldLease = lease as Awaited<ReturnType<
        PublicDatabaseAdmission["acquire"]
      >> | null;
      try {
        checkedOutClient?.release(destroyClient);
      } finally {
        heldLease?.release();
      }
    }
  };
}

const runPublicDatabaseReadScope = createPublicDatabaseReadScope({
  get pool() {
    return pool;
  },
  admission: publicDatabaseAdmission,
  executionTimeoutMs: appConfig.publicPgFallback.executionTimeoutMs,
  retryAfterSeconds: appConfig.publicPgFallback.retryAfterSeconds
});

export function withPublicDatabaseRead<T>(
  requestSignal: AbortSignal,
  work: (access: { reader: DatabaseReader }, signal: AbortSignal) => Promise<T>
) {
  return runPublicDatabaseReadScope(requestSignal, work);
}
