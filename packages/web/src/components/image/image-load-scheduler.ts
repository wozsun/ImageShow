export const imageLoadPriority = {
  detailOriginal: 0,
  detailPlaceholder: 1,
  viewport: 2,
  nearby: 3,
  background: 4
} as const;

export type ImageLoadPriority =
  (typeof imageLoadPriority)[keyof typeof imageLoadPriority];

export type ImageLoadTaskResult =
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "failed"; error: unknown };

export type ImageLoadTaskHandle = {
  cancel: () => void;
  cancelPending: () => boolean;
  reprioritize: (priority: ImageLoadPriority) => void;
  result: Promise<ImageLoadTaskResult>;
};

export type ImageLoadSchedulerSnapshot = {
  pending: number;
  inFlight: number;
};

type ImageLoadTask = {
  id: number;
  sequence: number;
  group: string;
  priority: ImageLoadPriority;
  controller: AbortController;
  run: (signal: AbortSignal) => Promise<void>;
  resolve: (result: ImageLoadTaskResult) => void;
  state: "pending" | "running" | "settled";
};

type GroupPauseOptions = {
  cancelPending?: boolean;
  cancelRunning?: boolean;
};

function abortError() {
  const error = new Error("Image load cancelled");
  error.name = "AbortError";
  return error;
}

function taskResult(task: ImageLoadTask, error?: unknown): ImageLoadTaskResult {
  if (task.controller.signal.aborted) return { status: "cancelled" };
  return error === undefined
    ? { status: "completed" }
    : { status: "failed", error };
}

/**
 * A small cooperative scheduler for DOM-backed image loads.
 *
 * The scheduler owns only queueing and slots. The task owns its DOM image and
 * must synchronously remove sources/listeners when its AbortSignal fires.
 */
export class ImageLoadScheduler {
  readonly #pending = new Map<number, ImageLoadTask>();
  readonly #running = new Map<number, ImageLoadTask>();
  readonly #pausedGroups = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #maxConcurrent: number;
  #nextId = 1;
  #nextSequence = 1;
  #disposed = false;

  constructor(maxConcurrent: number) {
    this.#maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  }

  schedule(options: {
    group?: string;
    priority: ImageLoadPriority;
    run: (signal: AbortSignal) => Promise<void>;
  }): ImageLoadTaskHandle {
    if (this.#disposed) {
      return {
        cancel: () => undefined,
        cancelPending: () => false,
        reprioritize: () => undefined,
        result: Promise.resolve({ status: "cancelled" })
      };
    }

    let resolveResult!: (result: ImageLoadTaskResult) => void;
    const result = new Promise<ImageLoadTaskResult>((resolve) => {
      resolveResult = resolve;
    });
    const task: ImageLoadTask = {
      id: this.#nextId++,
      sequence: this.#nextSequence++,
      group: options.group ?? "default",
      priority: options.priority,
      controller: new AbortController(),
      run: options.run,
      resolve: resolveResult,
      state: "pending"
    };
    this.#pending.set(task.id, task);
    this.#emit();
    this.#pump();

    return {
      cancel: () => this.#cancel(task),
      cancelPending: () => {
        if (task.state !== "pending") return false;
        this.#cancel(task);
        return true;
      },
      reprioritize: (priority) => {
        if (task.state !== "pending" || task.priority === priority) return;
        task.priority = priority;
        this.#pump();
      },
      result
    };
  }

  setMaxConcurrent(maxConcurrent: number) {
    const next = Math.max(1, Math.floor(maxConcurrent));
    if (next === this.#maxConcurrent) return;
    this.#maxConcurrent = next;
    this.#pump();
  }

  pauseGroup(group: string, options: GroupPauseOptions = {}) {
    this.#pausedGroups.add(group);
    if (options.cancelPending) {
      for (const task of [...this.#pending.values()]) {
        if (task.group === group) this.#cancel(task);
      }
    }
    if (options.cancelRunning) {
      for (const task of [...this.#running.values()]) {
        if (task.group === group) this.#cancel(task);
      }
    }
  }

  resumeGroup(group: string) {
    if (!this.#pausedGroups.delete(group)) return;
    this.#pump();
  }

  cancelGroup(group: string) {
    for (const task of [...this.#pending.values(), ...this.#running.values()]) {
      if (task.group === group) this.#cancel(task);
    }
  }

  snapshot(): ImageLoadSchedulerSnapshot {
    return {
      pending: this.#pending.size,
      inFlight: this.#running.size
    };
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const task of [...this.#pending.values(), ...this.#running.values()]) {
      this.#cancel(task);
    }
    this.#listeners.clear();
  }

  #cancel(task: ImageLoadTask) {
    if (task.state === "settled") return;
    if (task.state === "pending") {
      task.controller.abort(abortError());
      this.#settle(task, { status: "cancelled" });
      return;
    }
    if (!task.controller.signal.aborted) {
      // DOM-backed tasks synchronously clear their source in the abort handler.
      // The slot remains occupied until their Promise settles in the next
      // microtask, so cancellation cannot briefly exceed the concurrency cap.
      task.controller.abort(abortError());
    }
  }

  #nextPendingTask() {
    let candidate: ImageLoadTask | undefined;
    for (const task of this.#pending.values()) {
      if (this.#pausedGroups.has(task.group)) continue;
      if (
        !candidate
        || task.priority < candidate.priority
        || (
          task.priority === candidate.priority
          && task.sequence < candidate.sequence
        )
      ) {
        candidate = task;
      }
    }
    return candidate;
  }

  #pump() {
    if (this.#disposed) return;
    while (this.#running.size < this.#maxConcurrent) {
      const task = this.#nextPendingTask();
      if (!task) break;
      this.#pending.delete(task.id);
      this.#running.set(task.id, task);
      task.state = "running";
      this.#emit();
      void Promise.resolve()
        .then(() => task.run(task.controller.signal))
        .then(
          () => this.#settle(task, taskResult(task)),
          (error) => this.#settle(task, taskResult(task, error))
        );
    }
  }

  #settle(task: ImageLoadTask, result: ImageLoadTaskResult) {
    if (task.state === "settled") return;
    this.#pending.delete(task.id);
    this.#running.delete(task.id);
    task.state = "settled";
    task.resolve(result);
    this.#emit();
    this.#pump();
  }

  #emit() {
    for (const listener of this.#listeners) listener();
  }
}

export function preferredImageLoadConcurrency(
  matchMedia: (query: string) => Pick<MediaQueryList, "matches">
) {
  return (
    matchMedia("(pointer: fine)").matches
    && matchMedia("(min-width: 1024px)").matches
  ) ? 18 : 6;
}
