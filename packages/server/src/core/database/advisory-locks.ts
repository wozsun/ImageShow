import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import { abortSignalError, raceWithAbortSignal } from "../abort.ts";
import { connectAdvisoryLockClient } from "./pools.ts";

export type AdvisoryLockRequest = {
  key: string;
  mode?: "exclusive" | "shared";
  acquisition?: "wait" | "try";
};

export type AdvisoryLockAttempt<T> =
  | { acquired: true; value: T }
  | { acquired: false };

class AdvisoryLockLostError extends Error {
  readonly code = "advisory_lock_lost";

  constructor(cause?: unknown) {
    super("PostgreSQL advisory lock connection was lost", { cause });
    this.name = "AdvisoryLockLostError";
  }
}

type AdvisoryLockWork<T> = (
  signal: AbortSignal,
  lockClient: PoolClient
) => Promise<T>;

const advisoryLockSignalContext = new AsyncLocalStorage<AbortSignal>();
const poisonedAdvisoryClients = new WeakSet<PoolClient>();

export function runWithAdvisoryLockSignal<T>(
  signal: AbortSignal,
  work: () => Promise<T>
): Promise<T> {
  const parent = advisoryLockSignalContext.getStore();
  const combined = parent ? AbortSignal.any([parent, signal]) : signal;
  combined.throwIfAborted();
  return advisoryLockSignalContext.run(combined, work);
}

function combinedLockSignal(signal: AbortSignal) {
  const parent = advisoryLockSignalContext.getStore();
  return parent ? AbortSignal.any([parent, signal]) : signal;
}

export async function acquireAdvisoryLockClient(
  signal: AbortSignal | undefined,
  connect: () => Promise<PoolClient> = connectAdvisoryLockClient
) {
  signal?.throwIfAborted();
  const pending = connect();
  if (!signal) return pending;
  try {
    const client = await raceWithAbortSignal(signal, pending);
    signal.throwIfAborted();
    return client;
  } catch (error) {
    if (signal.aborted) {
      // node-postgres cannot cancel a queued pool checkout. Release a client
      // that arrives after the caller has already left the wait boundary.
      void pending.then((client) => {
        try {
          client.release();
        } catch {
          // The pool owns subsequent cleanup if a late release itself fails.
        }
      }, () => undefined);
    }
    throw error;
  }
}

function advisoryLockFunction(lock: AdvisoryLockRequest) {
  const tryAcquire = lock.acquisition === "try";
  if (lock.mode === "shared") {
    return tryAcquire ? "pg_try_advisory_lock_shared" : "pg_advisory_lock_shared";
  }
  return tryAcquire ? "pg_try_advisory_lock" : "pg_advisory_lock";
}

function advisoryUnlockFunction(lock: AdvisoryLockRequest) {
  return lock.mode === "shared"
    ? "pg_advisory_unlock_shared"
    : "pg_advisory_unlock";
}

async function runAdvisoryLockWork<T>(
  signal: AbortSignal,
  client: PoolClient,
  work: AdvisoryLockWork<T>
) {
  const operation = Promise.resolve().then(() => (
    advisoryLockSignalContext.run(signal, () => {
      signal.throwIfAborted();
      return work(signal, client);
    })
  ));
  try {
    const value = await raceWithAbortSignal(signal, operation);
    signal.throwIfAborted();
    return value;
  } catch (error) {
    if (signal.aborted) {
      await operation.catch(() => undefined);
      throw abortSignalError(signal);
    }
    throw error;
  }
}

async function runWithAdvisoryLocksOnClient<T>(
  client: PoolClient,
  signal: AbortSignal,
  locks: readonly AdvisoryLockRequest[],
  work: AdvisoryLockWork<T>
): Promise<AdvisoryLockAttempt<T>> {
  signal.throwIfAborted();
  if (poisonedAdvisoryClients.has(client)) throw new AdvisoryLockLostError();
  const acquired: AdvisoryLockRequest[] = [];
  try {
    for (const lock of locks) {
      let result;
      try {
        signal.throwIfAborted();
        result = await raceWithAbortSignal(
          signal,
          client.query(
            `SELECT ${advisoryLockFunction(lock)}(hashtext($1)) AS acquired`,
            [lock.key]
          )
        );
      } catch (error) {
        // The server may have acquired the lock before the response was lost.
        // The owning outer scope must destroy this session rather than reuse it.
        poisonedAdvisoryClients.add(client);
        throw error;
      }
      if (lock.acquisition === "try" && result.rows[0]?.acquired !== true) {
        return { acquired: false };
      }
      acquired.push(lock);
    }
    return {
      acquired: true,
      value: await runAdvisoryLockWork(signal, client, work)
    };
  } finally {
    for (const lock of acquired.reverse()) {
      if (poisonedAdvisoryClients.has(client)) break;
      try {
        const result = await client.query(
          `SELECT ${advisoryUnlockFunction(lock)}(hashtext($1)) AS unlocked`,
          [lock.key]
        );
        if (result.rows[0]?.unlocked !== true) {
          poisonedAdvisoryClients.add(client);
        }
      } catch {
        poisonedAdvisoryClients.add(client);
      }
    }
  }
}

async function runWithAdvisoryLocks<T>(
  locks: readonly AdvisoryLockRequest[],
  work: AdvisoryLockWork<T>
): Promise<AdvisoryLockAttempt<T>> {
  const checkoutSignal = advisoryLockSignalContext.getStore();
  const client = await acquireAdvisoryLockClient(checkoutSignal);
  let destroyClient = false;
  const connectionLoss = new AbortController();
  const lockSignal = combinedLockSignal(connectionLoss.signal);
  const connectionLost = (cause?: unknown) => {
    destroyClient = true;
    if (!connectionLoss.signal.aborted) {
      connectionLoss.abort(new AdvisoryLockLostError(cause));
    }
  };
  const onClientError = (error: Error) => connectionLost(error);
  const onClientEnd = () => connectionLost();
  client.on("error", onClientError);
  client.on("end", onClientEnd);
  try {
    return await runWithAdvisoryLocksOnClient(client, lockSignal, locks, work);
  } finally {
    destroyClient ||= poisonedAdvisoryClients.has(client);
    try {
      client.release(destroyClient);
    } finally {
      client.off("error", onClientError);
      client.off("end", onClientEnd);
    }
  }
}

/** Acquire additional advisory locks on an already-owned lock session. */
export async function withAdvisoryLocksOnClient<T>(
  client: PoolClient,
  signal: AbortSignal,
  locks: readonly Omit<AdvisoryLockRequest, "acquisition">[],
  work: AdvisoryLockWork<T>
): Promise<T> {
  const attempt = await runWithAdvisoryLocksOnClient(
    client,
    signal,
    locks,
    work
  );
  if (!attempt.acquired) {
    throw new Error("Blocking advisory lock was not acquired");
  }
  return attempt.value;
}

/** Try additional advisory locks without borrowing a second pool session. */
export function tryWithAdvisoryLocksOnClient<T>(
  client: PoolClient,
  signal: AbortSignal,
  locks: readonly AdvisoryLockRequest[],
  work: AdvisoryLockWork<T>
): Promise<AdvisoryLockAttempt<T>> {
  return runWithAdvisoryLocksOnClient(client, signal, locks, work);
}

export async function withAdvisoryLocks<T>(
  locks: readonly Omit<AdvisoryLockRequest, "acquisition">[],
  work: AdvisoryLockWork<T>
): Promise<T> {
  const attempt = await runWithAdvisoryLocks(locks, work);
  if (!attempt.acquired) {
    throw new Error("Blocking advisory lock was not acquired");
  }
  return attempt.value;
}

export function tryWithAdvisoryLocks<T>(
  locks: readonly AdvisoryLockRequest[],
  work: AdvisoryLockWork<T>
): Promise<AdvisoryLockAttempt<T>> {
  return runWithAdvisoryLocks(locks, work);
}

export function withAdvisoryLock<T>(
  key: string,
  work: AdvisoryLockWork<T>,
  mode: "exclusive" | "shared" = "exclusive"
): Promise<T> {
  return withAdvisoryLocks([{ key, mode }], work);
}
