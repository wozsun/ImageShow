import type {
  ImageLoadScheduler,
  ImageLoadSchedulerSnapshot
} from "../../components/image/image-load-scheduler.js";

export type GalleryDebugSnapshot = ImageLoadSchedulerSnapshot & {
  mountedTiles: number;
  mountedImgs: number;
  thumbnailFallbacks: number;
};

export type GalleryDebugController = {
  enabled: boolean;
  snapshot: () => GalleryDebugSnapshot;
  subscribe: (listener: () => void) => () => void;
  mountTile: () => () => void;
  mountImg: () => () => void;
  recordThumbnailFallback: () => void;
  resetThumbnailFallbacks: () => void;
};

const emptySnapshot: GalleryDebugSnapshot = {
  mountedTiles: 0,
  mountedImgs: 0,
  pending: 0,
  inFlight: 0,
  thumbnailFallbacks: 0
};
export class GalleryDebugStats implements GalleryDebugController {
  readonly enabled = true;
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
