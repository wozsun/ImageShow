export type MaterializationPipelineTask<T> = {
  materialize: () => Promise<T | null>;
  prepare: (materialized: T, startSuccessor: () => void) => Promise<void>;
  onError?: (error: unknown, stage: "materialize" | "prepare") => void | Promise<void>;
  onDiscard?: () => void | Promise<void>;
  onSettled?: () => void;
};

type MaterializationOutcome<T> =
  | { ok: true; value: T | null }
  | { ok: false; error: unknown };

type PipelineEntry<T> = {
  task: MaterializationPipelineTask<T>;
  finished: Promise<void>;
  resolve: () => void;
  settled: boolean;
  discarded: boolean;
};

type PipelineLane<T> = {
  current?: PipelineEntry<T>;
  successor?: PipelineEntry<T>;
  successorMaterialization?: Promise<MaterializationOutcome<T>>;
  lookaheadOpen: boolean;
};

function normalizedConcurrency(value: number) {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function pipelineEntry<T>(task: MaterializationPipelineTask<T>): PipelineEntry<T> {
  let resolve!: () => void;
  const finished = new Promise<void>((done) => {
    resolve = done;
  });
  return { task, finished, resolve, settled: false, discarded: false };
}

/**
 * Persistent, bounded two-stage scheduler shared by upload and download imports.
 * A lane may start exactly one successor after its current item enters prepare;
 * the successor cannot enter prepare until the current item has settled.
 */
export class MaterializationPipeline<T> {
  private concurrency: number;
  private disposed = false;
  private readonly pending: PipelineEntry<T>[] = [];
  private readonly lanes = new Set<PipelineLane<T>>();

  constructor(concurrency: number) {
    this.concurrency = normalizedConcurrency(concurrency);
  }

  setConcurrency(concurrency: number) {
    this.concurrency = normalizedConcurrency(concurrency);
    this.schedule();
  }

  resume() {
    this.disposed = false;
    this.schedule();
  }

  async enqueue(tasks: readonly MaterializationPipelineTask<T>[]) {
    const entries = tasks.map(pipelineEntry);
    if (this.disposed) {
      for (const entry of entries) this.discard(entry);
      await Promise.all(entries.map((entry) => entry.finished));
      return;
    }
    this.pending.push(...entries);
    this.schedule();
    await Promise.all(entries.map((entry) => entry.finished));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.pending.splice(0)) this.discard(entry);
    for (const lane of this.lanes) {
      if (lane.current) this.discard(lane.current);
      if (lane.successor) this.discard(lane.successor);
      lane.lookaheadOpen = false;
    }
  }

  private schedule() {
    if (this.disposed) return;

    // A lane that is already preparing gets first claim on newly appended work.
    // This preserves one-item lookahead instead of creating an unrelated pool.
    for (const lane of this.lanes) {
      if (!this.pending.length) break;
      if (!lane.lookaheadOpen || lane.successor) continue;
      const successor = this.pending.shift()!;
      lane.successor = successor;
      lane.successorMaterialization = this.materialize(successor);
      lane.lookaheadOpen = false;
    }

    while (this.pending.length && this.lanes.size < this.concurrency) {
      const lane: PipelineLane<T> = { lookaheadOpen: false };
      const first = this.pending.shift()!;
      this.lanes.add(lane);
      void this.runLane(lane, first);
    }
  }

  private async materialize(entry: PipelineEntry<T>): Promise<MaterializationOutcome<T>> {
    try {
      return { ok: true, value: await entry.task.materialize() };
    } catch (error) {
      return { ok: false, error };
    }
  }

  private async reportError(
    entry: PipelineEntry<T>,
    error: unknown,
    stage: "materialize" | "prepare"
  ) {
    try {
      await entry.task.onError?.(error, stage);
    } catch {
      // UI error reporting must never strand the scheduler lane.
    }
  }

  private settle(entry: PipelineEntry<T>) {
    if (entry.settled) return;
    entry.settled = true;
    try {
      entry.task.onSettled?.();
    } catch {
      // Resource bookkeeping must not keep enqueue callers waiting forever.
    } finally {
      entry.resolve();
    }
  }

  private discard(entry: PipelineEntry<T>) {
    if (entry.discarded) return;
    entry.discarded = true;
    try {
      const discarded = entry.task.onDiscard?.();
      if (discarded && "catch" in discarded) void discarded.catch(() => undefined);
    } catch {
      // Best-effort cleanup is also performed by the owning hook.
    }
    this.settle(entry);
  }

  private nextAfterCurrent(lane: PipelineLane<T>): {
    entry?: PipelineEntry<T>;
    materialization?: Promise<MaterializationOutcome<T>>;
  } {
    if (lane.successor) {
      const entry = lane.successor;
      const materialization = lane.successorMaterialization;
      lane.successor = undefined;
      lane.successorMaterialization = undefined;
      return { entry, materialization };
    }
    if (this.lanes.size > this.concurrency) return {};
    return { entry: this.pending.shift() };
  }

  private async runLane(lane: PipelineLane<T>, first: PipelineEntry<T>) {
    let current: PipelineEntry<T> | undefined = first;
    let currentMaterialization: Promise<MaterializationOutcome<T>> | undefined;
    try {
      while (current) {
        lane.current = current;
        if (this.disposed || current.discarded) {
          this.discard(current);
          break;
        }

        const materialized = await (currentMaterialization ?? this.materialize(current));
        currentMaterialization = undefined;
        if (this.disposed || current.discarded) {
          this.discard(current);
          break;
        }
        if (!materialized.ok) {
          await this.reportError(current, materialized.error, "materialize");
          this.settle(current);
          ({ entry: current, materialization: currentMaterialization } = this.nextAfterCurrent(lane));
          continue;
        }
        if (materialized.value === null) {
          this.settle(current);
          ({ entry: current, materialization: currentMaterialization } = this.nextAfterCurrent(lane));
          continue;
        }

        let prepareActive = true;
        let preparingStarted = false;
        const startSuccessor = () => {
          if (!prepareActive || preparingStarted || this.disposed || current?.discarded) return;
          preparingStarted = true;
          lane.lookaheadOpen = true;
          this.schedule();
        };
        try {
          await current.task.prepare(materialized.value, startSuccessor);
        } catch (error) {
          if (!this.disposed && !current.discarded) {
            await this.reportError(current, error, "prepare");
          }
        } finally {
          prepareActive = false;
          lane.lookaheadOpen = false;
          this.settle(current);
        }

        if (this.disposed) break;
        ({ entry: current, materialization: currentMaterialization } = this.nextAfterCurrent(lane));
      }
    } finally {
      lane.lookaheadOpen = false;
      if (lane.successor) this.discard(lane.successor);
      lane.current = undefined;
      lane.successor = undefined;
      lane.successorMaterialization = undefined;
      this.lanes.delete(lane);
      this.schedule();
    }
  }
}
