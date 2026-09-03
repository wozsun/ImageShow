import type {
  AdminImageListItemDto,
  IngestionCancelItemInputDto,
  IngestionCancelItemResultDto
} from "@imageshow/shared/browser";
import { appConfig } from "@imageshow/shared";
import { ApiError, errorMessage } from "../../../core/api-error.ts";
import { DynamicConcurrencyLimiter } from "../../../core/concurrency.ts";
import { logger } from "../../../core/logger.ts";
import {
  committedIngestionResultForOwner,
  readCommittedIngestionResultsByImageIds
} from "../../read-models/ingestion-results.ts";
import {
  cancelFailure,
  completedCancelResult,
  loadCancelItems,
  type LoadedCancelItem
} from "./items.ts";
import { cleanupRetiredSessions } from "./retired-cleanup.ts";
import {
  completedIngestionReceipt,
  publishCompletedReceipt
} from "../commit/completion.ts";
import { ingestionCleanupRetryQueue } from "../cleanup/retry-queue.ts";
import { IngestionIrreversibleCoordinator } from "../execution/irreversible-coordinator.ts";
import {
  ingestionSessionPairKey as pairKey,
  type IngestionSessionPair,
  type IngestionSessionSnapshot,
  type StoredIngestionSession
} from "../sessions/model.ts";
import { IngestionSessionRepository } from "../repository.ts";
import {
  discardedIngestionReceipt,
  semanticIngestionSession
} from "../sessions/transitions.ts";

type AbortActiveIngestion = (pair: IngestionSessionPair) => Promise<unknown> | void;
type CommittedIngestionResults = Awaited<
  ReturnType<typeof readCommittedIngestionResultsByImageIds>
>;

type CancelBoundaryValue =
  | Readonly<{
    status: "completed";
    cleanup: IngestionSessionSnapshot;
  }>
  | Readonly<{
    status: "discarded";
    cleanup: IngestionSessionSnapshot;
    queueRevision: number;
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

export type CancelIngestionSessionsOptions = Readonly<{
  expiryCutoff?: number;
}>;

type CancelIngestionSessionsDependencies = Readonly<{
  readCommitted: typeof readCommittedIngestionResultsByImageIds;
  scheduleCleanup?: (work: () => Promise<void>) => Promise<void> | void;
}>;

const defaultDependencies: CancelIngestionSessionsDependencies = {
  readCommitted: readCommittedIngestionResultsByImageIds,
  scheduleCleanup: (work) => ingestionCleanupRetryQueue.enqueue(work)
};

const cancelMutationSignal = new AbortController().signal;
const cancelMutationLimiter = new DynamicConcurrencyLimiter(
  () => appConfig.ingestionRuntime.queueActionBatchSize,
  (signal) => signal.reason ?? new Error("Ingestion cancellation stopped")
);

function abortActiveBestEffort(
  pair: IngestionSessionPair,
  abortActive: AbortActiveIngestion
) {
  try {
    void Promise.resolve(abortActive(pair)).catch((error) => {
      logger.warn("ingestion_discarded_abort_deferred", {
        session_id: pair.session_id,
        image_id: pair.image_id,
        error: errorMessage(error)
      });
    });
  } catch (error) {
    logger.warn("ingestion_discarded_abort_deferred", {
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
  session: StoredIngestionSession | null,
  pair: IngestionSessionPair
) {
  if (
    !session
    || session.session_id !== pair.session_id
    || session.image_id !== pair.image_id
    || session.status === "completed"
    || session.status === "discarded"
  ) return null;
  return session as IngestionSessionSnapshot;
}

async function retireCompletedSession(
  repository: IngestionSessionRepository,
  session: StoredIngestionSession | null,
  input: IngestionSessionPair,
  completedItem?: AdminImageListItemDto
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
          await publishCompletedReceipt(
            repository,
            session,
            Date.now(),
            completedItem
          );
        } catch (error) {
          // PostgreSQL has already established the authoritative outcome. A
          // stale Redis state or a raced CAS must not prevent the canonical
          // pair from being re-read and retired below.
          logger.warn("ingestion_completed_receipt_publish_deferred", {
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
          const active = terminal as IngestionSessionSnapshot;
          const discarded = await repository.mutateSemantic(
            active,
            active.version,
            discardedIngestionReceipt(active, Date.now())
          );
          terminal = discarded.session;
        }
      }
      if (terminal.status === "completed" || terminal.status === "discarded") {
        await repository.deleteSession(terminal, terminal.version);
      }
    } catch (error) {
      logger.warn("ingestion_completed_receipt_cleanup_deferred", {
        session_id: input.session_id,
        image_id: input.image_id,
        error: errorMessage(error)
      });
    }
  }
}

function committedExpiryTransition(
  active: IngestionSessionSnapshot,
  now: number
) {
  if (
    (active.status === "committing" || active.status === "resolving")
    && active.commit
  ) {
    return completedIngestionReceipt(active, now);
  }
  return discardedIngestionReceipt(active, now);
}

async function expireCommittedSession(
  repository: IngestionSessionRepository,
  current: StoredIngestionSession,
  cutoff: number
) {
  if (current.status === "completed" || current.status === "discarded") {
    await repository.expireSession(current, current.version, cutoff);
    return null;
  }
  const active = current as IngestionSessionSnapshot;
  await repository.expireSession(
    active,
    active.version,
    cutoff,
    committedExpiryTransition(active, Date.now())
  );
  return active;
}

async function expireResolvingSession(
  repository: IngestionSessionRepository,
  current: StoredIngestionSession,
  cutoff: number
) {
  if (current.status === "completed" || current.status === "discarded") {
    await repository.expireSession(current, current.version, cutoff);
    return current.status;
  }
  const active = current as IngestionSessionSnapshot;
  const resolving = semanticIngestionSession(active, {
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

async function cancelLoadedIngestionSessions(
  repository: IngestionSessionRepository,
  coordinator: IngestionIrreversibleCoordinator,
  loaded: readonly LoadedCancelItem[],
  abortActive: AbortActiveIngestion,
  options: CancelIngestionSessionsOptions = {},
  dependencies: CancelIngestionSessionsDependencies = defaultDependencies
) {
  if (!loaded.length) return [];
  const scheduleCleanup = dependencies.scheduleCleanup
    ?? ((work: () => Promise<void>) => ingestionCleanupRetryQueue.enqueue(work));
  const sessionsPendingCleanup = new Map<string, IngestionSessionSnapshot>();
  const rememberSessionForCleanup = (session: IngestionSessionSnapshot) => {
    sessionsPendingCleanup.set(pairKey(session), session);
  };
  const items = loaded.map(({ input }) => input);
  const sessions = loaded.map(({ session }) => session);
  const committedGate = deferred<CommittedIngestionResults>();
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
    const active = initial as IngestionSessionSnapshot;
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
        const committedResult = committedIngestionResultForOwner(
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
            const receipt = discardedIngestionReceipt(active, Date.now());
            let queueRevision: number;
            if (options.expiryCutoff === undefined) {
              const mutation = await repository.mutateSemantic(
                active,
                active.version,
                receipt
              );
              queueRevision = mutation.metadata.revision;
            } else {
              const mutation = await repository.expireSession(
                active,
                active.version,
                options.expiryCutoff,
                receipt
              );
              queueRevision = mutation.metadata.revision;
            }
            // Abort only after a known successful CAS. If the Redis response
            // is unknown, the execution token remains the durable fence and
            // the caller must retry instead of racing a current executor.
            abortActiveBestEffort(pair, abortActive);
            return {
              status: "discarded" as const,
              cleanup: active,
              queueRevision
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

  let committed: CommittedIngestionResults;
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

  const results: IngestionCancelItemResultDto[] = [];
  for (const [index, input] of items.entries()) {
    const pair = {
      session_id: input.session_id,
      image_id: input.image_id
    };
    const initial = sessions[index];
    const committedResult = committedIngestionResultForOwner(
      committed,
      input.image_id,
      loaded[index]!.owner
    );
    try {
      const work = workByIndex.get(index);
      if (work) {
        const outcome = outcomes.get(pairKey(pair));
        if (!outcome) {
          throw new Error("Ingestion cancel boundary result is missing");
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
                rememberSessionForCleanup(cleanup);
              }
            } else if (options.expiryCutoff === undefined) {
              abortActiveBestEffort(pair, abortActive);
              const cleanup = matchingActiveSession(current, pair)
                ?? matchingActiveSession(initial, pair);
              if (cleanup) {
                rememberSessionForCleanup(cleanup);
              }
              await retireCompletedSession(
                repository,
                current ?? initial,
                pair,
                committedResult.item
              );
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
                const resolving = semanticIngestionSession(current, {
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
          rememberSessionForCleanup(outcome.result.value.cleanup);
          if (!committedResult) {
            throw new Error("Completed cancel boundary omitted its PG result");
          }
          if (options.expiryCutoff === undefined) {
            abortActiveBestEffort(pair, abortActive);
            await retireCompletedSession(
              repository,
              initial,
              pair,
              committedResult.item
            );
          }
          results.push(completedCancelResult(pair, committedResult));
        } else {
          rememberSessionForCleanup(outcome.result.value.cleanup);
          results.push({
            ...pair,
            status: "discarded",
            queue_revision: outcome.result.value.queueRevision
          });
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
            rememberSessionForCleanup(cleanup);
          }
        } else if (options.expiryCutoff === undefined) {
          abortActiveBestEffort(pair, abortActive);
          const cleanup = matchingActiveSession(initial, pair);
          if (cleanup) {
            rememberSessionForCleanup(cleanup);
          }
          await retireCompletedSession(
            repository,
            initial,
            pair,
            committedResult.item
          );
        }
        results.push(completedCancelResult(pair, committedResult));
        continue;
      }
      if (loaded[index]!.incarnationMismatch) {
        throw new ApiError(
          409,
          "ingestion_incarnation_conflict",
          "内容接入任务身份已被替换"
        );
      }
      if (!initial) {
        throw new ApiError(
          410,
          "ingestion_session_missing",
          "未完成内容接入已过期或被服务器丢弃"
        );
      }
      if (initial.status === "completed") {
        await repository.deleteSession(initial, initial.version);
        throw new ApiError(
          410,
          "ingestion_session_missing",
          "完成回执对应的 PostgreSQL 图片已不存在"
        );
      }
      if (initial.status === "discarded") {
        results.push({
          ...pair,
          status: "discarded",
          queue_revision: initial.last_semantic_revision
        });
        continue;
      }
      if (initial.version !== input.expected_version) {
        throw new ApiError(409, "ingestion_version_conflict", "内容接入任务版本已变化");
      }
      throw new Error(
        "Ingestion cancel boundary was not created for an active session"
      );
    } catch (error) {
      results.push(cancelFailure(pair, error));
    }
  }
  const retiredSessions = [...sessionsPendingCleanup.values()];
  // The commit path installs a persistent move.cleanup guard before copying
  // any formal media/thumb candidate. Cancellation only needs best-effort
  // cleanup for disposable raw and staging material here.
  if (retiredSessions.length) {
    await scheduleCleanup(() => cleanupRetiredSessions(retiredSessions));
  }
  return results;
}

export async function cancelIngestionSessions(
  repository: IngestionSessionRepository,
  coordinator: IngestionIrreversibleCoordinator,
  owner: string,
  items: readonly IngestionCancelItemInputDto[],
  abortActive: AbortActiveIngestion,
  options: CancelIngestionSessionsOptions = {},
  dependencies: CancelIngestionSessionsDependencies = defaultDependencies
) {
  return cancelLoadedIngestionSessions(
    repository,
    coordinator,
    await loadCancelItems(repository, owner, items),
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
export function cancelRecoveredIngestionSessions(
  repository: IngestionSessionRepository,
  coordinator: IngestionIrreversibleCoordinator,
  sessions: readonly IngestionSessionSnapshot[],
  abortActive: AbortActiveIngestion,
  options: CancelIngestionSessionsOptions = {},
  dependencies: CancelIngestionSessionsDependencies = defaultDependencies
) {
  return cancelLoadedIngestionSessions(
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
