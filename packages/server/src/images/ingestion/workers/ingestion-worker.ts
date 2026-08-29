import { appConfig } from "@imageshow/shared";
import {
  getRuntimeConfig,
  onRuntimeConfigChange
} from "../../../config/runtime-config-store.ts";
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
import {
  ingestionCommitAdmissionSnapshot,
  withIngestionCommitAdmission
} from "../commit/admission.ts";
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
import { withImportPrefetchAdmission } from "./import-prefetch.ts";
import {
  ingestionPreparationAdmissionSnapshot
} from "./preparation-admission.ts";

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

export type IngestionWorkerLane = "import" | "upload" | "commit";
type IngestionPreCommitLane = Exclude<IngestionWorkerLane, "commit">;

type ActiveIngestion = {
  pair: IngestionSessionPair;
  lane: IngestionWorkerLane;
  dispatchSlotHeld: boolean;
  controller: AbortController;
  promise: Promise<void>;
};

export function ingestionCommitDispatchWindow(concurrency: number) {
  // Keep only half a batch ready. This hides Redis discovery handoff without
  // turning tasks waiting on count/byte admission into another worker pool.
  return concurrency + Math.ceil(concurrency / 2);
}

export function ingestionWorkerDispatchWindows(
  normalizeConcurrency: number,
  commitConcurrency: number
) {
  return {
    // Import releases this dispatch slot as soon as Normalize admits the item,
    // so N represents exactly the downloading / waiting successor batch.
    import: normalizeConcurrency,
    // Upload has no remote materialization stage and retains its dispatch slot
    // until prepare settles, avoiding a second in-memory Normalize queue.
    upload: normalizeConcurrency,
    commit: ingestionCommitDispatchWindow(commitConcurrency)
  } satisfies Record<IngestionWorkerLane, number>;
}

function ingestionRunnablePassComplete(
  page: Readonly<{
    scanned: number;
    lastScannedScore: number;
    frozenTailScore: number;
  }>,
  cursorScore: number
) {
  return (
    !page.scanned
    || page.lastScannedScore === cursorScore
    || page.lastScannedScore >= page.frozenTailScore
  );
}

function ingestionWorkerLaneForSession(
  session: IngestionSessionSnapshot
): IngestionWorkerLane | null {
  if (session.status === "queued") return "import";
  if (session.status === "received") {
    return session.queue === "import" ? "import" : "upload";
  }
  if (session.status === "committing") return "commit";
  return null;
}

export function planIngestionWorkerLanes(
  sessions: readonly StoredIngestionSession[],
  active: Iterable<Readonly<{
    pair: IngestionSessionPair;
    lane: IngestionWorkerLane;
    dispatchSlotHeld?: boolean;
  }>>,
  previouslyBlocked: ReadonlySet<IngestionWorkerLane> = new Set(),
  windows: Readonly<Record<IngestionWorkerLane, number>>
    = ingestionWorkerDispatchWindows(
      appConfig.runtimeDefaults.normalize.concurrency,
      appConfig.runtimeDefaults.ingestion.commit_concurrency
    )
) {
  const remaining: Record<IngestionWorkerLane, number> = {
    ...windows
  };
  const activeKeys = new Set<string>();
  for (const item of active) {
    activeKeys.add(pairKey(item.pair));
    if (item.dispatchSlotHeld !== false) remaining[item.lane] -= 1;
  }
  const blockedLanes = new Set(previouslyBlocked);
  const candidates: Array<Readonly<{
    session: IngestionSessionSnapshot;
    lane: IngestionWorkerLane;
  }>> = [];
  for (const session of sessions) {
    if (session.status === "completed" || session.status === "discarded") continue;
    if (activeKeys.has(pairKey(session))) continue;
    const lane = ingestionWorkerLaneForSession(session);
    if (!lane || blockedLanes.has(lane)) continue;
    if (remaining[lane] <= 0) {
      // Do not let a later page overtake this session if a slot is released
      // before the current frozen-tail pass returns to the beginning.
      blockedLanes.add(lane);
      continue;
    }
    remaining[lane] -= 1;
    candidates.push({ session, lane });
  }
  return { candidates, blockedLanes };
}

export class IngestionSessionWorker {
  readonly repository: IngestionSessionRepository;
  readonly #coordinator: IngestionIrreversibleCoordinator;
  readonly #recovery: IngestionSessionRecovery;
  readonly #active = new Map<string, ActiveIngestion>();
  #accepting = false;
  #timer: NodeJS.Timeout | null = null;
  #tickPromise: Promise<void> | null = null;
  #removeRedisListener: (() => void) | null = null;
  #removeRuntimeConfigListener: (() => void) | null = null;
  #generalTickRequested = false;
  #commitRefillRequested = false;
  #preCommitRefillRequested = new Set<IngestionPreCommitLane>();
  #normalizeConcurrency = 1;
  #commitConcurrency = 1;
  // Runnable scores are globally monotonic, so this fixed tail makes each
  // keyset pass immune to sessions appended while the pass is in progress.
  #runnableCursorScore = 0;
  #runnableFrozenTailScore = 0;
  #runnableBlockedLanes = new Set<IngestionWorkerLane>();
  // Commit refills advance through their own frozen-tail pass. They never
  // rewind the shared cross-lane cursor, and a full window retains its page
  // boundary so the next refill cannot skip the remainder of that page.
  #commitRefillCursorScore = 0;
  #commitRefillFrozenTailScore = 0;
  readonly #preCommitRefillCursors = {
    import: { cursorScore: 0, frozenTailScore: 0 },
    upload: { cursorScore: 0, frozenTailScore: 0 }
  } satisfies Record<
    IngestionPreCommitLane,
    { cursorScore: number; frozenTailScore: number }
  >;

  constructor(
    repository = new IngestionSessionRepository(),
    coordinator = new IngestionIrreversibleCoordinator()
  ) {
    this.repository = repository;
    this.#coordinator = coordinator;
    this.#recovery = new IngestionSessionRecovery(
      repository,
      coordinator,
      (pair) => this.abortActive(pair)
    );
  }

  start() {
    if (this.#timer) return;
    this.#accepting = getRedisOperationalState().available;
    const initialRuntime = getRuntimeConfig();
    this.#normalizeConcurrency = initialRuntime.normalize.concurrency;
    this.#commitConcurrency = initialRuntime.ingestion.commit_concurrency;
    this.#resetRecovery();
    this.#removeRuntimeConfigListener = onRuntimeConfigChange(() => {
      const next = getRuntimeConfig();
      const nextNormalize = next.normalize.concurrency;
      const nextCommit = next.ingestion.commit_concurrency;
      const normalizeRaised = nextNormalize > this.#normalizeConcurrency;
      const commitRaised = nextCommit > this.#commitConcurrency;
      this.#normalizeConcurrency = nextNormalize;
      this.#commitConcurrency = nextCommit;
      if (normalizeRaised) {
        this.#schedulePreCommitRefill("import");
        this.#schedulePreCommitRefill("upload");
      }
      if (commitRaised) this.#scheduleCommitRefill();
    });
    this.#removeRedisListener = onRedisOperationalStateChange((state) => {
      if (!state.available) {
        this.#pause(state.reason);
        return;
      }
      this.#accepting = true;
      this.#resetRecovery();
      this.#scheduleTick();
    });
    this.#timer = setInterval(() => {
      void this.tick().catch((error) => {
        logger.error("ingestion_worker_tick_failed", error);
      });
    }, 500);
    this.#timer.unref();
    this.#scheduleTick();
  }

  #resetRunnablePass() {
    this.#runnableCursorScore = 0;
    this.#runnableFrozenTailScore = 0;
    this.#runnableBlockedLanes.clear();
    this.#commitRefillCursorScore = 0;
    this.#commitRefillFrozenTailScore = 0;
    for (const cursor of Object.values(this.#preCommitRefillCursors)) {
      cursor.cursorScore = 0;
      cursor.frozenTailScore = 0;
    }
    this.#preCommitRefillRequested.clear();
  }

  #resetRecovery() {
    this.#recovery.reset();
    this.#resetRunnablePass();
  }

  #ensureTick() {
    if (this.#tickPromise) return this.#tickPromise;
    const runGeneral = this.#generalTickRequested;
    const refillCommit = this.#commitRefillRequested;
    const refillPreCommit = [...this.#preCommitRefillRequested];
    this.#generalTickRequested = false;
    this.#commitRefillRequested = false;
    this.#preCommitRefillRequested.clear();
    const promise = this.#runTick({
      runGeneral,
      refillCommit,
      refillPreCommit
    }).finally(() => {
      if (this.#tickPromise === promise) this.#tickPromise = null;
      if (
        this.#accepting
        && (
          this.#generalTickRequested
          || this.#commitRefillRequested
          || this.#preCommitRefillRequested.size > 0
        )
      ) {
        void this.#ensureTick().catch((error) => {
          logger.error("ingestion_worker_tick_failed", error);
        });
      }
    });
    this.#tickPromise = promise;
    return promise;
  }

  #scheduleTick() {
    this.#generalTickRequested = true;
    void this.#ensureTick().catch((error) => {
      logger.error("ingestion_worker_tick_failed", error);
    });
  }

  #scheduleCommitRefill() {
    if (!this.#accepting) return;
    this.#commitRefillRequested = true;
    void this.#ensureTick().catch((error) => {
      logger.error("ingestion_worker_commit_refill_failed", error);
    });
  }

  #schedulePreCommitRefill(lane: IngestionPreCommitLane) {
    if (!this.#accepting) return;
    this.#preCommitRefillRequested.add(lane);
    void this.#ensureTick().catch((error) => {
      logger.error("ingestion_worker_pre_commit_refill_failed", { lane, error });
    });
  }

  #pause(reason: unknown) {
    this.#accepting = false;
    this.#generalTickRequested = false;
    this.#commitRefillRequested = false;
    this.#preCommitRefillRequested.clear();
    for (const active of this.#active.values()) {
      if (this.#coordinator.state(active.pair) === "database_started") continue;
      active.controller.abort(reason);
    }
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#removeRedisListener?.();
    this.#removeRedisListener = null;
    this.#removeRuntimeConfigListener?.();
    this.#removeRuntimeConfigListener = null;
    this.#pause(new Error("Ingestion worker stopping"));
  }

  abortActive(pair: IngestionSessionPair) {
    const active = this.#active.get(pairKey(pair));
    active?.controller.abort(new ApiError(409, "ingestion_cancelled", "内容接入已取消"));
    return active?.promise;
  }

  tick() {
    this.#generalTickRequested = true;
    return this.#ensureTick();
  }

  diagnostics() {
    const active = {
      import: 0,
      upload: 0,
      commit: 0
    } satisfies Record<IngestionWorkerLane, number>;
    const heldDispatchSlots = { ...active };
    for (const item of this.#active.values()) {
      active[item.lane] += 1;
      if (item.dispatchSlotHeld) heldDispatchSlots[item.lane] += 1;
    }
    return {
      accepting: this.#accepting,
      recoveryComplete: this.#recovery.complete,
      tickActive: this.#tickPromise !== null,
      active,
      heldDispatchSlots,
      activePromises: this.#active.size,
      activeAbortControllers: this.#active.size,
      dispatchWindows: ingestionWorkerDispatchWindows(
        this.#normalizeConcurrency,
        this.#commitConcurrency
      ),
      preparationAdmission: ingestionPreparationAdmissionSnapshot(),
      commitAdmission: ingestionCommitAdmissionSnapshot()
    } as const;
  }

  #activeCommitCount() {
    let count = 0;
    for (const item of this.#active.values()) {
      if (item.lane === "commit") count += 1;
    }
    return count;
  }

  #heldPreCommitDispatchSlotCount(lane: IngestionPreCommitLane) {
    let count = 0;
    for (const item of this.#active.values()) {
      if (item.lane === lane && item.dispatchSlotHeld) count += 1;
    }
    return count;
  }

  async #runTick(options: Readonly<{
    runGeneral: boolean;
    refillCommit: boolean;
    refillPreCommit: readonly IngestionPreCommitLane[];
  }>) {
    if (!this.#accepting) return;
    if (!this.#recovery.complete) {
      await this.#recovery.step();
      return;
    }
    if (await this.#recovery.drainExpired()) return;
    if (options.refillCommit) await this.#refillCommitDispatchWindow();
    for (const lane of options.refillPreCommit) {
      if (!this.#accepting) return;
      await this.#refillPreCommitLane(lane);
    }
    if (!options.runGeneral || !this.#accepting) return;
    await this.#scanRunnablePage();
  }

  async #refillPreCommitLane(lane: IngestionPreCommitLane) {
    if (this.#heldPreCommitDispatchSlotCount(lane) >= this.#normalizeConcurrency) {
      return;
    }
    const limit = appConfig.ingestionRuntime.ingestionSessionScanBatchSize;
    const cursor = this.#preCommitRefillCursors[lane];
    const page = await this.repository.discoverRunnablePage(
      cursor.cursorScore,
      cursor.frozenTailScore,
      limit
    );
    if (!this.#accepting) return;
    for (const { session } of page.items) {
      if (this.#heldPreCommitDispatchSlotCount(lane) >= this.#normalizeConcurrency) {
        return;
      }
      if (session.status === "completed" || session.status === "discarded") {
        continue;
      }
      if (ingestionWorkerLaneForSession(session) !== lane) continue;
      this.#startSession(session, lane);
    }
    if (ingestionRunnablePassComplete(page, cursor.cursorScore)) {
      cursor.cursorScore = 0;
      cursor.frozenTailScore = 0;
      return;
    }
    cursor.cursorScore = page.lastScannedScore;
    cursor.frozenTailScore = page.frozenTailScore;
    if (this.#heldPreCommitDispatchSlotCount(lane) < this.#normalizeConcurrency) {
      // Continue one bounded page at a time without rewinding the cross-lane
      // cursor or allowing a later runnable item to overtake an earlier one.
      this.#preCommitRefillRequested.add(lane);
    }
  }

  async #refillCommitDispatchWindow() {
    const limit = appConfig.ingestionRuntime.ingestionSessionScanBatchSize;
    if (
      this.#activeCommitCount()
      >= ingestionCommitDispatchWindow(this.#commitConcurrency)
    ) return;
    const page = await this.repository.discoverRunnablePage(
      this.#commitRefillCursorScore,
      this.#commitRefillFrozenTailScore,
      limit
    );
    if (!this.#accepting) return;
    for (const { session } of page.items) {
      if (
        this.#activeCommitCount()
        >= ingestionCommitDispatchWindow(this.#commitConcurrency)
      ) return;
      if (session.status !== "committing") continue;
      this.#startSession(session, "commit");
    }
    if (ingestionRunnablePassComplete(
      page,
      this.#commitRefillCursorScore
    )) {
      this.#commitRefillCursorScore = 0;
      this.#commitRefillFrozenTailScore = 0;
      return;
    }
    this.#commitRefillCursorScore = page.lastScannedScore;
    this.#commitRefillFrozenTailScore = page.frozenTailScore;
    if (
      this.#activeCommitCount()
      < ingestionCommitDispatchWindow(this.#commitConcurrency)
    ) {
      // Continue one bounded Redis page at a time. Timer-driven general scans
      // can join between pages, so sparse Commit work cannot monopolize the
      // shared Worker loop.
      this.#commitRefillRequested = true;
    }
  }

  async #scanRunnablePage() {
    const limit = appConfig.ingestionRuntime.ingestionSessionScanBatchSize;
    const page = await this.repository.discoverRunnablePage(
      this.#runnableCursorScore,
      this.#runnableFrozenTailScore,
      limit
    );
    const passComplete = ingestionRunnablePassComplete(
      page,
      this.#runnableCursorScore
    );
    const plan = planIngestionWorkerLanes(
      page.items.map(({ session }) => session),
      this.#active.values(),
      this.#runnableBlockedLanes,
      ingestionWorkerDispatchWindows(
        this.#normalizeConcurrency,
        this.#commitConcurrency
      )
    );
    for (const { session, lane } of plan.candidates) {
      if (!this.#accepting) break;
      this.#startSession(session, lane);
    }
    if (passComplete) {
      this.#runnableCursorScore = 0;
      this.#runnableFrozenTailScore = 0;
      this.#runnableBlockedLanes.clear();
    } else {
      this.#runnableCursorScore = page.lastScannedScore;
      this.#runnableFrozenTailScore = page.frozenTailScore;
      this.#runnableBlockedLanes = plan.blockedLanes;
    }
  }

  #startSession(
    session: IngestionSessionSnapshot,
    lane: IngestionWorkerLane
  ) {
    const key = pairKey(session);
    if (this.#active.has(key)) return false;
    const controller = new AbortController();
    const active: ActiveIngestion = {
      pair: session,
      lane,
      dispatchSlotHeld: true,
      controller,
      promise: Promise.resolve()
    };
    let failedExecution: IngestionSessionSnapshot | null = null;
    active.promise = this.#runSession(
      session,
      controller.signal,
      (execution) => {
        failedExecution = execution;
      },
      () => this.#releasePreCommitDispatchSlot(active)
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
        if (this.#active.get(key) !== active) return;
        this.#active.delete(key);
        // Refill while all N permits can still be occupied. Waiting count or
        // byte admission remains in #active and is never fetched again as an
        // apparent empty slot.
        if (
          lane === "commit"
          && this.#accepting
          && this.#activeCommitCount() <= this.#commitConcurrency
        ) {
          this.#scheduleCommitRefill();
        } else if (lane !== "commit" && active.dispatchSlotHeld) {
          active.dispatchSlotHeld = false;
          this.#schedulePreCommitRefill(lane);
        }
      });
    this.#active.set(key, active);
    return true;
  }

  #releasePreCommitDispatchSlot(active: ActiveIngestion) {
    if (active.lane === "commit" || !active.dispatchSlotHeld) return;
    active.dispatchSlotHeld = false;
    this.#schedulePreCommitRefill(active.lane);
  }

  async #runSession(
    session: IngestionSessionSnapshot,
    signal: AbortSignal,
    onExecution: (session: IngestionSessionSnapshot) => void,
    onImportNormalizationAdmitted: () => void
  ) {
    if (session.status === "queued") {
      return withImportPrefetchAdmission(signal, async (onNormalizationAdmitted) => {
        const claimed = await this.#claimStage(session, "downloading");
        onExecution(claimed);
        const downloaded = await downloadIngestionSessionSnapshot(
          this.repository,
          claimed,
          signal
        );
        signal.throwIfAborted();
        const preparing = await this.#claimStage(downloaded, "preparing");
        onExecution(preparing);
        await this.#prepareSession(
          preparing,
          signal,
          () => {
            onNormalizationAdmitted();
            onImportNormalizationAdmitted();
          }
        );
      });
    }
    if (session.status === "received") {
      const prepare = async (onNormalizationAdmitted?: () => void) => {
        signal.throwIfAborted();
        const claimed = await this.#claimStage(session, "preparing");
        onExecution(claimed);
        await this.#prepareSession(
          claimed,
          signal,
          onNormalizationAdmitted
        );
      };
      return session.queue === "import"
        ? withImportPrefetchAdmission(signal, (onNormalizationAdmitted) => (
            prepare(() => {
              onNormalizationAdmitted();
              onImportNormalizationAdmitted();
            })
          ))
        : prepare();
    }
    if (session.status === "committing") {
      const bytes = Math.max(
        1,
        (session.prepared?.size ?? 0) + (session.prepared?.thumbnail_size ?? 0)
      );
      return withIngestionCommitAdmission(
        bytes,
        signal,
        () => {
          onExecution(session);
          return commitIngestionSessionSnapshot(
            this.repository,
            this.#coordinator,
            session,
            signal
          );
        }
      );
    }
  }

  #prepareSession(
    session: IngestionSessionSnapshot,
    signal: AbortSignal,
    onNormalizationAdmitted?: () => void
  ) {
    return withIngestionExecutionHeartbeat(
      this.repository,
      session,
      signal,
      (executionSignal) => prepareIngestionSessionSnapshot(
        this.repository,
        session,
        executionSignal,
        { onNormalizationAdmitted }
      )
    );
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
          this.#coordinator,
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
      logger.error("ingestion_worker_failure_publish_failed", {
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
      await this.#coordinator.waitForDatabaseTransactions();
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
    await this.#coordinator.waitForDatabaseTransactions();
    return drained;
  }
}
