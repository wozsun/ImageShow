import type {
  ImportCancelItemInputDto,
  ImportCancelItemResultDto
} from "@imageshow/shared/browser";
import { appConfig } from "@imageshow/shared";
import { ApiError, errorMessage } from "../../core/api-error.ts";
import {
  DynamicConcurrencyLimiter,
  mapWithWorkerPool
} from "../../core/concurrency.ts";
import { logger } from "../../core/logger.ts";
import { withStorageLocationReadLock } from "../../storage/maintenance-lock.ts";
import { removeStorageObjectAndConfirm } from "../../storage/object-access.ts";
import {
  committedImportResultForOwner,
  readCommittedImportResultsByImageIds,
  type CommittedImportResult
} from "../read-models/import-results.ts";
import {
  completedImportReceipt,
  publishCompletedReceipt
} from "./commit-worker.ts";
import { importRetiredCleanupQueue } from "./cleanup-queue.ts";
import { ImportIrreversibleCoordinator } from "./irreversible-coordinator.ts";
import {
  removeImportRaw
} from "./raw-files.ts";
import {
  importSessionPairKey as pairKey,
  type ImportSessionPair,
  type ImportSessionSnapshot,
  type StoredImportSession
} from "./session-model.ts";
import {
  importSessionIncarnationMismatch,
  ImportSessionRepository
} from "./session-repository.ts";
import {
  discardedImportReceipt,
  semanticImportSession
} from "./session-transitions.ts";

type AbortActiveImport = (pair: ImportSessionPair) => Promise<unknown> | void;
type CommittedImportResults = Awaited<
  ReturnType<typeof readCommittedImportResultsByImageIds>
>;

type CancelBoundaryValue =
  | Readonly<{
    status: "completed";
    cleanup: ImportSessionSnapshot;
  }>
  | Readonly<{
    status: "discarded";
    cleanup: ImportSessionSnapshot;
  }>;

type CancelBoundaryResult =
  | Readonly<{
    status: "discarded";
    value: CancelBoundaryValue;
  }>
  | Readonly<{
    status: "resolving";
    settled: Promise<unknown>;
  }>;

type BoundaryOutcome =
  | Readonly<{ ok: true; result: CancelBoundaryResult }>
  | Readonly<{ ok: false; error: unknown }>;

type ActiveBoundaryWork = Readonly<{
  admitted: Promise<void>;
  outcome: Promise<BoundaryOutcome>;
}>;

export type CancelImportSessionsOptions = Readonly<{
  expiryCutoff?: number;
}>;

type CancelImportSessionsDependencies = Readonly<{
  readCommitted: typeof readCommittedImportResultsByImageIds;
  scheduleCleanup?: (work: () => Promise<void>) => Promise<void> | void;
}>;

type LoadedCancelItem = Readonly<{
  owner: string;
  input: ImportCancelItemInputDto;
  session: StoredImportSession | null;
  incarnationMismatch?: boolean;
}>;

const defaultDependencies: CancelImportSessionsDependencies = {
  readCommitted: readCommittedImportResultsByImageIds,
  scheduleCleanup: (work) => importRetiredCleanupQueue.enqueue(work)
};

const cancelMutationSignal = new AbortController().signal;
const cancelMutationLimiter = new DynamicConcurrencyLimiter(
  () => appConfig.importRuntime.queueActionBatchSize,
  (signal) => signal.reason ?? new Error("Import cancellation stopped")
);

function failure(
  input: ImportSessionPair,
  error: unknown
): ImportCancelItemResultDto {
  return {
    ...input,
    status: "failed",
    code: error instanceof ApiError ? error.code : "import_cancel_failed",
    message: error instanceof Error ? error.message : "Import cancel failed"
  };
}

function abortActiveBestEffort(
  pair: ImportSessionPair,
  abortActive: AbortActiveImport
) {
  try {
    void Promise.resolve(abortActive(pair)).catch((error) => {
      logger.warn("discarded_import_abort_deferred", {
        session_id: pair.session_id,
        image_id: pair.image_id,
        error: errorMessage(error)
      });
    });
  } catch (error) {
    logger.warn("discarded_import_abort_deferred", {
      session_id: pair.session_id,
      image_id: pair.image_id,
      error: errorMessage(error)
    });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function matchingActiveSession(
  session: StoredImportSession | null,
  pair: ImportSessionPair
) {
  if (
    !session
    || session.session_id !== pair.session_id
    || session.image_id !== pair.image_id
    || session.status === "completed"
    || session.status === "discarded"
  ) return null;
  return session as ImportSessionSnapshot;
}

async function cleanupRetiredSession(
  session: ImportSessionSnapshot
) {
  // Cleanup admission is asynchronous and can outlive the tombstone that
  // originally fenced pair reuse. Delete only this frozen generation; a new
  // incarnation may already own another raw in the same image directory by
  // the time a retry runs. Old parts and unknown generations remain age-scan
  // work.
  const cleanups: Promise<unknown>[] = session.raw_generation
    ? [removeImportRaw(session.queue, session, session.raw_generation)]
    : [];
  if (session.prepared) {
    cleanups.push(withStorageLocationReadLock(async (signal) => {
      const removals = await Promise.allSettled([
        removeStorageObjectAndConfirm(
          "_uploads",
          session.prepared!.prepared_image_key,
          session.storage_slug,
          { signal }
        ),
        removeStorageObjectAndConfirm(
          "_uploads",
          session.prepared!.prepared_thumbnail_key,
          session.storage_slug,
          { signal }
        )
      ]);
      const failures = removals.flatMap((result) => (
        result.status === "rejected" ? [result.reason] : []
      ));
      if (failures.length) {
        throw new AggregateError(
          failures,
          "Retired import staging cleanup failed"
        );
      }
    }));
  }
  const results = await Promise.allSettled(cleanups);
  const failures = results.flatMap((result) => (
    result.status === "rejected" ? [result.reason] : []
  ));
  if (failures.length) {
    throw new AggregateError(failures, "Retired import cleanup failed");
  }
}

async function cleanupRetiredSessions(
  cleanupPlans: readonly ImportSessionSnapshot[]
) {
  const failures: unknown[] = [];
  await mapWithWorkerPool(
    cleanupPlans,
    1,
    async (session) => {
      try {
        await cleanupRetiredSession(session);
      } catch (error) {
        failures.push(error);
      }
    }
  );
  if (failures.length) {
    throw new AggregateError(failures, "Retired import batch cleanup failed");
  }
}

function completedCancelResult(
  pair: ImportSessionPair,
  result: CommittedImportResult
): ImportCancelItemResultDto {
  return {
    ...pair,
    status: "completed",
    completed_item: result.item
  };
}

async function retireCompletedSession(
  repository: ImportSessionRepository,
  session: StoredImportSession | null,
  input: ImportSessionPair
) {
  if (
    session
    && session.session_id === input.session_id
    && session.image_id === input.image_id
  ) {
    try {
      let terminal = session;
      if (session.status !== "completed" && session.status !== "discarded") {
        try {
          await publishCompletedReceipt(repository, session, Date.now());
        } catch (error) {
          // PostgreSQL has already established the authoritative outcome. A
          // stale Redis state or a raced CAS must not prevent the canonical
          // pair from being re-read and retired below.
          logger.warn("completed_import_receipt_publish_deferred", {
            session_id: input.session_id,
            image_id: input.image_id,
            error: errorMessage(error)
          });
        }
        const current = await repository.readSession(
          session.owner,
          session.session_id
        );
        if (!current || current.image_id !== input.image_id) {
          return;
        }
        terminal = current;
        // A PostgreSQL row can predate a non-commit canonical (for example a
        // response-loss retry). It is still authoritative completion, but no
        // commit receipt can be synthesized without a frozen intent. Retire
        // that disposable canonical through the normal tombstone boundary.
        if (terminal.status !== "completed" && terminal.status !== "discarded") {
          const active = terminal as ImportSessionSnapshot;
          const discarded = await repository.mutateSemantic(
            active,
            active.version,
            discardedImportReceipt(active, Date.now())
          );
          terminal = discarded.session;
        }
      }
      if (terminal.status === "completed" || terminal.status === "discarded") {
        await repository.deleteSession(terminal, terminal.version);
      }
    } catch (error) {
      logger.warn("completed_import_receipt_cleanup_deferred", {
        session_id: input.session_id,
        image_id: input.image_id,
        error: errorMessage(error)
      });
    }
  }
}

function committedExpiryTransition(
  active: ImportSessionSnapshot,
  now: number
) {
  if (
    (active.status === "committing" || active.status === "resolving")
    && active.commit
  ) {
    return completedImportReceipt(active, now);
  }
  return discardedImportReceipt(active, now);
}

async function expireCommittedSession(
  repository: ImportSessionRepository,
  current: StoredImportSession,
  cutoff: number
) {
  if (current.status === "completed" || current.status === "discarded") {
    await repository.expireSession(current, current.version, cutoff);
    return null;
  }
  const active = current as ImportSessionSnapshot;
  await repository.expireSession(
    active,
    active.version,
    cutoff,
    committedExpiryTransition(active, Date.now())
  );
  return active;
}

async function expireResolvingSession(
  repository: ImportSessionRepository,
  current: StoredImportSession,
  cutoff: number
) {
  if (current.status === "completed" || current.status === "discarded") {
    await repository.expireSession(current, current.version, cutoff);
    return current.status;
  }
  const active = current as ImportSessionSnapshot;
  const resolving = semanticImportSession(active, {
    status: "resolving",
    phase: "resolving",
    message: "数据库事务已经开始，正在确认最终结果",
    progress: null
  });
  await repository.expireSession(
    active,
    active.version,
    cutoff,
    resolving
  );
  return "resolving" as const;
}

async function cancelLoadedImportSessions(
  repository: ImportSessionRepository,
  coordinator: ImportIrreversibleCoordinator,
  loaded: readonly LoadedCancelItem[],
  abortActive: AbortActiveImport,
  options: CancelImportSessionsOptions = {},
  dependencies: CancelImportSessionsDependencies = defaultDependencies
) {
  if (!loaded.length) return [];
  const scheduleCleanup = dependencies.scheduleCleanup
    ?? ((work: () => Promise<void>) => importRetiredCleanupQueue.enqueue(work));
  const retiredCleanups = new Map<string, ImportSessionSnapshot>();
  const scheduleRetiredCleanup = (session: ImportSessionSnapshot) => {
    retiredCleanups.set(pairKey(session), session);
  };
  const items = loaded.map(({ input }) => input);
  const sessions = loaded.map(({ session }) => session);
  const committedGate = deferred<CommittedImportResults>();
  // A database_started boundary never awaits the gate. Mark its possible
  // rejection as observed while cancellable boundaries still receive it.
  void committedGate.promise.catch(() => undefined);
  const workByPair = new Map<string, ActiveBoundaryWork>();
  const workByIndex = new Map<number, ActiveBoundaryWork>();

  for (const [index, input] of items.entries()) {
    const initial = sessions[index];
    if (
      !initial
      || initial.status === "completed"
      || initial.status === "discarded"
      || initial.version !== input.expected_version
    ) continue;
    const active = initial as ImportSessionSnapshot;
    const pair = {
      session_id: input.session_id,
      image_id: input.image_id
    };
    const key = pairKey(pair);
    let work = workByPair.get(key);
    if (!work) {
      const admission = deferred<void>();
      const boundary = coordinator.cancelBoundary(pair, async () => {
        // Holding this pair's critical section before the shared PostgreSQL
        // read closes the final cancellable-to-database-started race without
        // degrading a batch cancellation into one query per item.
        admission.resolve();
        const committed = await committedGate.promise;
        const committedResult = committedImportResultForOwner(
          committed,
          pair.image_id,
          loaded[index]!.owner
        );
        return cancelMutationLimiter.run(
          cancelMutationSignal,
          async () => {
            if (committedResult) {
              if (options.expiryCutoff !== undefined) {
                await expireCommittedSession(
                  repository,
                  active,
                  options.expiryCutoff
                );
                abortActiveBestEffort(pair, abortActive);
              }
              return {
                status: "completed" as const,
                cleanup: active
              };
            }
            const receipt = discardedImportReceipt(active, Date.now());
            if (options.expiryCutoff === undefined) {
              await repository.mutateSemantic(
                active,
                active.version,
                receipt
              );
            } else {
              await repository.expireSession(
                active,
                active.version,
                options.expiryCutoff,
                receipt
              );
            }
            // Abort only after a known successful CAS. If the Redis response
            // is unknown, the execution token remains the durable fence and
            // the caller must retry instead of racing a current executor.
            abortActiveBestEffort(pair, abortActive);
            return {
              status: "discarded" as const,
              cleanup: active
            };
          }
        );
      });
      const outcome = boundary.then<BoundaryOutcome, BoundaryOutcome>(
        (result) => {
          admission.resolve();
          return { ok: true, result };
        },
        (error: unknown) => {
          admission.resolve();
          return { ok: false, error };
        }
      );
      work = {
        admitted: admission.promise,
        outcome
      };
      workByPair.set(key, work);
    }
    workByIndex.set(index, work);
  }

  let committed: CommittedImportResults;
  try {
    await Promise.all([...workByPair.values()].map((work) => work.admitted));
    committed = await dependencies.readCommitted(
      [...new Set(items.map((item) => item.image_id))]
    );
    committedGate.resolve(committed);
  } catch (error) {
    if (workByPair.size) {
      committedGate.reject(error);
      await Promise.all([...workByPair.values()].map((work) => work.outcome));
    }
    throw error;
  }

  const outcomes = new Map<string, BoundaryOutcome>();
  await Promise.all([...workByPair.entries()].map(async ([key, work]) => {
    outcomes.set(key, await work.outcome);
  }));

  const results: ImportCancelItemResultDto[] = [];
  for (const [index, input] of items.entries()) {
    const pair = {
      session_id: input.session_id,
      image_id: input.image_id
    };
    const initial = sessions[index];
    const committedResult = committedImportResultForOwner(
      committed,
      input.image_id,
      loaded[index]!.owner
    );
    try {
      const work = workByIndex.get(index);
      if (work) {
        const outcome = outcomes.get(pairKey(pair));
        if (!outcome) {
          throw new Error("Import cancel boundary result is missing");
        }
        if (!outcome.ok) throw outcome.error;
        if (outcome.result.status === "resolving") {
          const current = await repository.readSession(
            loaded[index]!.owner,
            input.session_id
          );
          if (committedResult) {
            if (
              options.expiryCutoff !== undefined
              && current
              && current.image_id === input.image_id
            ) {
              const cleanup = await expireCommittedSession(
                repository,
                current,
                options.expiryCutoff
              );
              if (cleanup) {
                scheduleRetiredCleanup(cleanup);
              }
            } else if (options.expiryCutoff === undefined) {
              abortActiveBestEffort(pair, abortActive);
              const cleanup = matchingActiveSession(current, pair)
                ?? matchingActiveSession(initial, pair);
              if (cleanup) {
                scheduleRetiredCleanup(cleanup);
              }
              await retireCompletedSession(repository, current ?? initial, pair);
            }
            results.push(completedCancelResult(pair, committedResult));
            continue;
          }
          if (
            current
            && current.image_id === input.image_id
          ) {
            if (options.expiryCutoff === undefined) {
              if (current.status === "committing") {
                const resolving = semanticImportSession(current, {
                  status: "resolving",
                  phase: "resolving",
                  message: "数据库事务已经开始，正在确认最终结果",
                  progress: null
                });
                await repository.mutateSemantic(
                  current,
                  current.version,
                  resolving
                ).catch(() => undefined);
              }
            } else {
              await expireResolvingSession(
                repository,
                current,
                options.expiryCutoff
              );
            }
          }
          results.push({ ...pair, status: "resolving" });
          continue;
        }
        if (outcome.result.value.status === "completed") {
          scheduleRetiredCleanup(outcome.result.value.cleanup);
          if (options.expiryCutoff === undefined) {
            abortActiveBestEffort(pair, abortActive);
            await retireCompletedSession(repository, initial, pair);
          }
          if (!committedResult) {
            throw new Error("Completed cancel boundary omitted its PG result");
          }
          results.push(completedCancelResult(pair, committedResult));
        } else {
          scheduleRetiredCleanup(outcome.result.value.cleanup);
          results.push({ ...pair, status: "discarded" });
        }
        continue;
      }

      if (committedResult) {
        if (options.expiryCutoff !== undefined && initial) {
          const cleanup = await expireCommittedSession(
            repository,
            initial,
            options.expiryCutoff
          );
          if (cleanup) {
            abortActiveBestEffort(pair, abortActive);
            scheduleRetiredCleanup(cleanup);
          }
        } else if (options.expiryCutoff === undefined) {
          abortActiveBestEffort(pair, abortActive);
          const cleanup = matchingActiveSession(initial, pair);
          if (cleanup) {
            scheduleRetiredCleanup(cleanup);
          }
          await retireCompletedSession(repository, initial, pair);
        }
        results.push(completedCancelResult(pair, committedResult));
        continue;
      }
      if (loaded[index]!.incarnationMismatch) {
        throw new ApiError(
          409,
          "import_incarnation_conflict",
          "导入任务身份已被替换"
        );
      }
      if (!initial) {
        throw new ApiError(
          410,
          "import_session_missing",
          "未完成导入已过期或被服务器丢弃"
        );
      }
      if (initial.status === "completed") {
        await repository.deleteSession(initial, initial.version);
        throw new ApiError(
          410,
          "import_session_missing",
          "完成回执对应的 PostgreSQL 图片已不存在"
        );
      }
      if (initial.status === "discarded") {
        results.push({ ...pair, status: "discarded" });
        continue;
      }
      if (initial.version !== input.expected_version) {
        throw new ApiError(409, "import_version_conflict", "导入任务版本已变化");
      }
      throw new Error(
        "Import cancel boundary was not created for an active session"
      );
    } catch (error) {
      results.push(failure(pair, error));
    }
  }
  const cleanupPlans = [...retiredCleanups.values()];
  // The commit path installs a persistent move.cleanup guard before copying
  // any formal media/thumb candidate. Cancellation only needs best-effort
  // cleanup for disposable raw and staging material here.
  if (cleanupPlans.length) {
    await scheduleCleanup(() => cleanupRetiredSessions(cleanupPlans));
  }
  return results;
}

export async function cancelImportSessions(
  repository: ImportSessionRepository,
  coordinator: ImportIrreversibleCoordinator,
  owner: string,
  items: readonly ImportCancelItemInputDto[],
  abortActive: AbortActiveImport,
  options: CancelImportSessionsOptions = {},
  dependencies: CancelImportSessionsDependencies = defaultDependencies
) {
  const sessions = await repository.readSessions(owner, items);
  return cancelLoadedImportSessions(
    repository,
    coordinator,
    items.map((input, index) => ({
      owner,
      input,
      session: sessions[index] === importSessionIncarnationMismatch
        ? null
        : sessions[index] ?? null,
      incarnationMismatch:
        sessions[index] === importSessionIncarnationMismatch
    })),
    abortActive,
    options,
    dependencies
  );
}

/**
 * Recovery has already loaded and structurally verified these canonical
 * snapshots. Keeping them in one coordinator admission batch prevents owner
 * scoping from degrading the shared PostgreSQL outcome read into N queries.
 */
export function cancelRecoveredImportSessions(
  repository: ImportSessionRepository,
  coordinator: ImportIrreversibleCoordinator,
  sessions: readonly ImportSessionSnapshot[],
  abortActive: AbortActiveImport,
  options: CancelImportSessionsOptions = {},
  dependencies: CancelImportSessionsDependencies = defaultDependencies
) {
  return cancelLoadedImportSessions(
    repository,
    coordinator,
    sessions.map((session) => ({
      owner: session.owner,
      input: {
        session_id: session.session_id,
        image_id: session.image_id,
        expected_version: session.version
      },
      session
    })),
    abortActive,
    options,
    dependencies
  );
}
