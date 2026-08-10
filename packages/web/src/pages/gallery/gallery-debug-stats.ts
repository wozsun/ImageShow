import type {
  ImageLoadScheduler,
  ImageLoadSchedulerSnapshot
} from "../../components/image/image-load-scheduler.js";

export type GalleryDebugSnapshot = ImageLoadSchedulerSnapshot & {
  mountedTiles: number;
  mountedImgs: number;
  thumbnailFallbacks: number;
  fetchedPages: number;
  retainedPages: number;
  queryCachePages: number;
  compactItems: number;
  fullItems: number;
  materializedPositions: number;
  compactLayoutBytes: number;
  estimatedCompactBytes: number;
  estimatedFullDtoBytes: number;
  revealHighWater: number;
  usedJsHeapBytes: number | null;
};

export type GalleryDataWindowMetrics = Pick<
  GalleryDebugSnapshot,
  | "fetchedPages"
  | "retainedPages"
  | "queryCachePages"
  | "compactItems"
  | "fullItems"
  | "materializedPositions"
  | "compactLayoutBytes"
  | "estimatedCompactBytes"
  | "estimatedFullDtoBytes"
>;

export type GalleryDebugController = {
  snapshot: () => GalleryDebugSnapshot;
  subscribe: (listener: () => void) => () => void;
  mountTile: () => () => void;
  mountImg: () => () => void;
  recordThumbnailFallback: () => void;
  resetThumbnailFallbacks: () => void;
  resetDataWindow: () => void;
  updateDataWindow: (metrics: GalleryDataWindowMetrics) => void;
  recordReveal: (imageIndex: number) => void;
  sampleJsHeap: () => void;
};

const emptySnapshot: GalleryDebugSnapshot = {
  mountedTiles: 0,
  mountedImgs: 0,
  pending: 0,
  inFlight: 0,
  thumbnailFallbacks: 0,
  fetchedPages: 0,
  retainedPages: 0,
  queryCachePages: 0,
  compactItems: 0,
  fullItems: 0,
  materializedPositions: 0,
  compactLayoutBytes: 0,
  estimatedCompactBytes: 0,
  estimatedFullDtoBytes: 0,
  revealHighWater: -1,
  usedJsHeapBytes: null
};

function currentJsHeapBytes() {
  const memory = globalThis.performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  };
  const used = memory?.memory?.usedJSHeapSize;
  return typeof used === "number" && Number.isFinite(used)
    ? Math.max(0, used)
    : null;
}

export class GalleryDebugStats implements GalleryDebugController {
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribeScheduler: () => void;
  #snapshot: GalleryDebugSnapshot = emptySnapshot;

  constructor(scheduler: ImageLoadScheduler) {
    const updateScheduler = () => {
      this.#snapshot = {
        ...this.#snapshot,
        ...scheduler.snapshot()
      };
      this.#emit();
    };
    this.#unsubscribeScheduler = scheduler.subscribe(updateScheduler);
    updateScheduler();
  }

  snapshot = () => this.#snapshot;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  mountTile() {
    return this.#increment("mountedTiles");
  }

  mountImg() {
    return this.#increment("mountedImgs");
  }

  recordThumbnailFallback() {
    this.#snapshot = {
      ...this.#snapshot,
      thumbnailFallbacks: this.#snapshot.thumbnailFallbacks + 1
    };
    this.#emit();
  }

  resetThumbnailFallbacks() {
    if (this.#snapshot.thumbnailFallbacks === 0) return;
    this.#snapshot = { ...this.#snapshot, thumbnailFallbacks: 0 };
    this.#emit();
  }

  resetDataWindow() {
    this.#snapshot = {
      ...this.#snapshot,
      fetchedPages: 0,
      retainedPages: 0,
      queryCachePages: 0,
      compactItems: 0,
      fullItems: 0,
      materializedPositions: 0,
      compactLayoutBytes: 0,
      estimatedCompactBytes: 0,
      estimatedFullDtoBytes: 0,
      revealHighWater: -1
    };
    this.#emit();
  }

  updateDataWindow(metrics: GalleryDataWindowMetrics) {
    const fields = Object.keys(metrics) as Array<keyof GalleryDataWindowMetrics>;
    const changed = fields.some(
      (field) => this.#snapshot[field] !== metrics[field]
    );
    if (!changed) return;
    this.#snapshot = { ...this.#snapshot, ...metrics };
    this.#emit();
  }

  recordReveal(imageIndex: number) {
    const next = Math.max(
      this.#snapshot.revealHighWater,
      Math.floor(imageIndex)
    );
    if (next === this.#snapshot.revealHighWater) return;
    this.#snapshot = { ...this.#snapshot, revealHighWater: next };
    this.#emit();
  }

  sampleJsHeap() {
    const usedJsHeapBytes = currentJsHeapBytes();
    if (usedJsHeapBytes === this.#snapshot.usedJsHeapBytes) return;
    this.#snapshot = { ...this.#snapshot, usedJsHeapBytes };
    this.#emit();
  }

  dispose() {
    this.#unsubscribeScheduler();
    this.#listeners.clear();
  }

  #increment(field: "mountedTiles" | "mountedImgs") {
    let active = true;
    this.#snapshot = {
      ...this.#snapshot,
      [field]: this.#snapshot[field] + 1
    };
    this.#emit();
    return () => {
      if (!active) return;
      active = false;
      this.#snapshot = {
        ...this.#snapshot,
        [field]: Math.max(0, this.#snapshot[field] - 1)
      };
      this.#emit();
    };
  }

  #emit() {
    for (const listener of this.#listeners) listener();
  }
}
