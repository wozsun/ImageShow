import { appConfig } from "@imageshow/shared";
import { getRuntimeConfig } from "../../../config/runtime-config-store.ts";
import { ApiError, errorMessage } from "../../../core/api-error.ts";
import { logger } from "../../../core/logger.ts";
import {
  getRedisOperationalState,
  onRedisOperationalStateChange
} from "../../../core/runtime-availability.ts";
import { randomUuidV7 } from "../../../core/uuid.ts";
import {
  committedIngestionResultForOwner,
  readCommittedIngestionResultsByImageIds
} from "../../read-models/ingestion-results.ts";
import { cancelIngestionSessions } from "../cancel/coordinator.ts";
import { recoverIngestionCommitDuplicateConflict } from "../commit/conflict-recovery.ts";
import { publishCompletedReceipt } from "../commit/completion.ts";
import { commitIngestionSessionSnapshot } from "../commit/worker.ts";
import { downloadIngestionSessionSnapshot } from "../sources/download-session.ts";
import { withIngestionExecutionHeartbeat } from "../execution/heartbeat.ts";
import { mutateIngestionExecution } from "../execution/session.ts";
import { IngestionIrreversibleCoordinator } from "../execution/irreversible-coordinator.ts";
import { prepareIngestionSessionSnapshot } from "./prepare-session.ts";
import {
  ingestionSessionPairKey as pairKey,
  type IngestionSessionPair,
  type IngestionSessionSnapshot,
  type StoredIngestionSession
} from "../sessions/model.ts";
import { IngestionSessionRecovery } from "./session-recovery.ts";
import { IngestionSessionRepository } from "../repository.ts";
import {
  failedIngestionSession,
  semanticIngestionSession
} from "../sessions/transitions.ts";
import { IngestionWorkerStagePools } from "./stage-pools.ts";

function workerCancellationError(signal: AbortSignal) {
  return signal.reason ?? new ApiError(409, "import_worker_stopped", "内容接入 worker 已停止");
}

export function isSameFailedIngestionExecution(
  current: StoredIngestionSession,
  failed: IngestionSessionSnapshot
) {
  if (
    current.image_id !== failed.image_id
    || !("execution_token" in current)
    || !failed.execution_token
    || current.execution_token !== failed.execution_token
  ) return false;
  if (current.status === failed.status) {
    return current.version === failed.version || (
      current.version > failed.version
      && (current.status === "downloading" || current.status === "preparing")
    );
  }
  return failed.status === "committing"
    && current.status === "resolving"
    && current.version === failed.version + 1;
}

type ActiveIngestion = {
  pair: IngestionSessionPair;
  stage: "download" | "prepare" | "commit";
  controller: AbortController;
  promise: Promise<void>;
};

export class IngestionSessionWorker {
  readonly repository: IngestionSessionRepository;
  readonly coordinator: IngestionIrreversibleCoordinator;
  readonly #stagePools = new IngestionWorkerStagePools({
    download: () => getRuntimeConfig().import.global_concurrency,
    prepare: () => Math.max(
      getRuntimeConfig().upload.global_concurrency,
      getRuntimeConfig().import.global_concurrency
    ),
    commit: () => getRuntimeConfig().ingestion.global_commit_concurrency,
    commitBytes: () => (
      getRuntimeConfig().ingestion.global_commit_byte_budget_mb * 1024 * 1024
    )
  }, workerCancellationError);
  readonly #recovery: IngestionSessionRecovery;
  readonly #active = new Map<string, ActiveIngestion>();
  #accepting = false;
  #timer: NodeJS.Timeout | null = null;
  #tickPromise: Promise<void> | null = null;
  #removeRedisListener: (() => void) | null = null;
  // Runnable scores are globally monotonic, so this fixed tail makes each
  // keyset pass immune to sessions appended while the pass is in progress.
  #runnableCursorScore = 0;
  #runnableFrozenTailScore = 0;

  constructor(
    repository = new IngestionSessionRepository(),
    coordinator = new IngestionIrreversibleCoordinator()
  ) {
    this.repository = repository;
    this.coordinator = coordinator;
    this.#recovery = new IngestionSessionRecovery(
      repository,
      coordinator,
      (pair) => this.abortActive(pair)
    );
  }

  start() {
    if (this.#timer) return;
    this.#accepting = getRedisOperationalState().available;
    this.#resetRecovery();
    this.#removeRedisListener = onRedisOperationalStateChange((state) => {
      if (!state.available) {
        this.#pause(state.reason);
        return;
      }
      this.#accepting = true;
      this.#resetRecovery();
      void this.tick().catch((error) => {
        logger.error("import worker recovery failed", error);
      });
    });
    this.#timer = setInterval(() => {
      void this.tick().catch((error) => {
        logger.error("import worker tick failed", error);
      });
    }, 500);
    this.#timer.unref();
    void this.tick().catch((error) => {
      logger.error("import worker startup failed", error);
    });
  }

  #resetRecovery() {
    this.#recovery.reset();
    this.#runnableCursorScore = 0;
    this.#runnableFrozenTailScore = 0;
  }

  #pause(reason: unknown) {
    this.#accepting = false;
    for (const active of this.#active.values()) {
      if (this.coordinator.state(active.pair) === "database_started") continue;
      active.controller.abort(reason);
    }
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#removeRedisListener?.();
    this.#removeRedisListener = null;
    this.#pause(new Error("Import worker stopping"));
  }

  abortActive(pair: IngestionSessionPair) {
    const active = this.#active.get(pairKey(pair));
    active?.controller.abort(new ApiError(409, "import_cancelled", "内容接入已取消"));
    return active?.promise;
  }

  tick() {
    if (this.#tickPromise) return this.#tickPromise;
    this.#tickPromise = this.#runTick().finally(() => {
      this.#tickPromise = null;
    });
    return this.#tickPromise;
  }

  async #runTick() {
    if (!this.#accepting) return;
    if (!this.#recovery.complete) {
      await this.#recovery.step();
      return;
    }
    if (await this.#recovery.drainExpired()) return;
    const limit = appConfig.ingestionRuntime.recoveryScanBatchSize;
    const page = await this.repository.discoverRunnablePage(
      this.#runnableCursorScore,
      this.#runnableFrozenTailScore,
      limit
    );
    if (
      !page.scanned
      || page.lastScannedScore === this.#runnableCursorScore
      || page.lastScannedScore >= page.frozenTailScore
    ) {
      this.#runnableCursorScore = 0;
      this.#runnableFrozenTailScore = 0;
    } else {
      this.#runnableCursorScore = page.lastScannedScore;
      this.#runnableFrozenTailScore = page.frozenTailScore;
    }
    const remaining = this.#remainingStageAdmissions();
    for (const { session } of page.items) {
      if (!this.#accepting) break;
      if (session.status === "completed" || session.status === "discarded") continue;
      const stage = this.#stageForSession(session);
      if (!stage || remaining[stage] <= 0) continue;
      if (this.#startSession(session, stage)) remaining[stage] -= 1;
    }
  }

  #stageForSession(session: IngestionSessionSnapshot) {
    if (session.status === "queued") return "download" as const;
    if (session.status === "received") return "prepare" as const;
    if (session.status === "committing") return "commit" as const;
    return null;
  }

  #remainingStageAdmissions() {
    const runtime = getRuntimeConfig();
    const remaining = {
      download: runtime.import.global_concurrency,
      prepare: Math.max(
        runtime.upload.global_concurrency,
        runtime.import.global_concurrency
      ),
      commit: runtime.ingestion.global_commit_concurrency
    };
    for (const active of this.#active.values()) remaining[active.stage] -= 1;
    return remaining;
  }

  #startSession(
    session: IngestionSessionSnapshot,
    stage: ActiveIngestion["stage"]
  ) {
    const key = pairKey(session);
    if (this.#active.has(key)) return false;
    const controller = new AbortController();
    const active: ActiveIngestion = {
      pair: session,
      stage,
      controller,
      promise: Promise.resolve()
    };
    let failedExecution: IngestionSessionSnapshot | null = null;
    active.promise = this.#runSession(
      session,
      controller.signal,
      (execution) => {
        failedExecution = execution;
      }
    )
      .then(() => undefined)
      .catch(async (error) => {
        if (failedExecution) {
          await this.#settleStageFailure(
            failedExecution,
            error,
            controller.signal
          );
        }
      })
      .finally(() => {
        if (this.#active.get(key) === active) this.#active.delete(key);
      });
    this.#active.set(key, active);
    return true;
  }

  async #runSession(
    session: IngestionSessionSnapshot,
    signal: AbortSignal,
    onExecution: (session: IngestionSessionSnapshot) => void
  ) {
    if (session.status === "queued") {
      return this.#stagePools.download(signal, async () => {
        const claimed = await this.#claimStage(session, "downloading");
        onExecution(claimed);
        await downloadIngestionSessionSnapshot(this.repository, claimed, signal);
      });
    }
    if (session.status === "received") {
      return this.#stagePools.prepare(signal, async () => {
        const claimed = await this.#claimStage(session, "preparing");
        onExecution(claimed);
        await withIngestionExecutionHeartbeat(
          this.repository,
          claimed,
          signal,
          (executionSignal) => prepareIngestionSessionSnapshot(
            this.repository,
            claimed,
            executionSignal
          )
        );
      });
    }
    if (session.status === "committing") {
      const bytes = Math.max(
        1,
        (session.prepared?.size ?? 0) + (session.prepared?.thumbnail_size ?? 0)
      );
      return this.#stagePools.commit(
        bytes,
        signal,
        () => {
          onExecution(session);
          return commitIngestionSessionSnapshot(
            this.repository,
            this.coordinator,
            session,
            signal
          );
        }
      );
    }
  }

  async #claimStage(
    session: IngestionSessionSnapshot,
    status: "downloading" | "preparing"
  ) {
    const next = semanticIngestionSession(session, {
      status,
      phase: status,
      message: status === "downloading"
        ? "服务器正在下载原图"
        : "服务器正在处理图片",
      progress: status === "downloading" ? 0 : null,
      execution_token: randomUuidV7(),
      error: undefined
    });
    return (await this.repository.mutateSemantic(
      session,
      session.version,
      next
    )).session as IngestionSessionSnapshot;
  }

  async #settleStageFailure(
    execution: IngestionSessionSnapshot,
    error: unknown,
    signal: AbortSignal
  ) {
    if (signal.aborted || !this.#accepting) return;
    try {
      const current = await this.repository.readSession(
        execution.owner,
        execution.session_id
      );
      if (
        !current
        || current.status === "completed"
        || current.status === "discarded"
        || !isSameFailedIngestionExecution(current, execution)
      ) return;
      const committed = await readCommittedIngestionResultsByImageIds([
        current.image_id
      ]);
      if (committedIngestionResultForOwner(
        committed,
        current.image_id,
        current.owner
      )) {
        await publishCompletedReceipt(
          this.repository,
          current as IngestionSessionSnapshot,
          Date.now()
        );
        return;
      }
      if (
        !("execution_token" in current)
        || !["downloading", "preparing", "committing", "resolving"].includes(current.status)
      ) return;
      if (current.status === "resolving") {
        await cancelIngestionSessions(
          this.repository,
          this.coordinator,
          current.owner,
          [{
            session_id: current.session_id,
            image_id: current.image_id,
            expected_version: current.version
          }],
          (pair) => this.abortActive(pair)
        );
        return;
      }
      if (await recoverIngestionCommitDuplicateConflict(
        this.repository,
        current,
        error
      )) return;
      await mutateIngestionExecution(
        this.repository,
        current,
        (latest) => failedIngestionSession(latest, error)
      );
    } catch (settleError) {
      logger.error("import worker failure could not be published", {
        session_id: execution.session_id,
        image_id: execution.image_id,
        stage_error: errorMessage(error),
        settle_error: errorMessage(settleError)
      });
    }
  }

  async drain(timeoutMs = appConfig.backgroundJob.drainTimeoutMs) {
    const work = Promise.allSettled([
      ...[...this.#active.values()].map((active) => active.promise),
      ...(this.#tickPromise ? [this.#tickPromise] : [])
    ]).then(() => true);
    if (timeoutMs <= 0) {
      const drained = this.#active.size === 0 && !this.#tickPromise;
      await this.coordinator.waitForDatabaseTransactions();
      return drained;
    }
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const drained = await Promise.race([work, deadline]);
    if (timer) clearTimeout(timer);
    // Once PostgreSQL may have started, graceful shutdown never abandons that
    // transaction merely because cancellable stage draining reached its
    // deadline. Its result remains the sole completion truth.
    await this.coordinator.waitForDatabaseTransactions();
    return drained;
  }
}
