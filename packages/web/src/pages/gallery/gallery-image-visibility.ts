import {
  galleryLoadBufferScreens,
  galleryResidenceBufferScreens
} from "../../lib/constants.js";

export type GalleryImageVisibility = {
  inViewport: boolean;
  inLoadRange: boolean;
  inResidenceRange: boolean;
};

type GalleryVisibilityListener = (
  visibility: GalleryImageVisibility
) => void;

type VisibilityRecord = {
  state: GalleryImageVisibility;
  listener: GalleryVisibilityListener;
};

type ObserverKind = keyof GalleryImageVisibility;

const observerKinds: ObserverKind[] = [
  "inViewport",
  "inLoadRange",
  "inResidenceRange"
];

function visibilityRootMargin(
  kind: ObserverKind,
  viewportHeight: number
) {
  if (kind === "inViewport") return "0px";
  const screens = kind === "inLoadRange"
    ? galleryLoadBufferScreens
    : galleryResidenceBufferScreens;
  return `${Math.max(1, Math.ceil(viewportHeight * screens))}px 0px`;
}

function equalVisibility(
  left: GalleryImageVisibility,
  right: GalleryImageVisibility
) {
  return left.inViewport === right.inViewport
    && left.inLoadRange === right.inLoadRange
    && left.inResidenceRange === right.inResidenceRange;
}

export function shouldRefreshGalleryVisibility(
  previous: { width: number; height: number },
  next: { width: number; height: number }
) {
  return Math.abs(next.width - previous.width) >= 1
    || Math.abs(next.height - previous.height)
      >= Math.max(96, previous.height * 0.15);
}

/**
 * Gallery-scoped visibility registry. It owns exactly three shared observers:
 * viewport priority, load range, and the wider residence range used for
 * hysteresis. Only mounted virtual tiles are registered.
 */
export class GalleryImageVisibilityController {
  readonly #records = new Map<Element, VisibilityRecord>();
  readonly #observers = new Map<ObserverKind, IntersectionObserver>();
  #viewportHeight: number;
  #disposed = false;

  constructor(viewportHeight: number) {
    this.#viewportHeight = Math.max(1, Math.ceil(viewportHeight));
  }

  observe(target: Element, listener: GalleryVisibilityListener) {
    if (this.#disposed) {
      listener({
        inViewport: false,
        inLoadRange: false,
        inResidenceRange: false
      });
      return () => undefined;
    }
    if (typeof IntersectionObserver === "undefined") {
      const visible = {
        inViewport: true,
        inLoadRange: true,
        inResidenceRange: true
      };
      this.#records.set(target, { state: visible, listener });
      listener(visible);
      return () => {
        this.#records.delete(target);
      };
    }

    this.#records.set(target, {
      state: {
        inViewport: false,
        inLoadRange: false,
        inResidenceRange: false
      },
      listener
    });
    if (this.#observers.size === 0) this.#createObservers();
    for (const observer of this.#observers.values()) observer.observe(target);

    return () => {
      for (const observer of this.#observers.values()) {
        observer.unobserve(target);
      }
      this.#records.delete(target);
      if (this.#records.size === 0) {
        for (const observer of this.#observers.values()) {
          observer.disconnect();
        }
        this.#observers.clear();
      }
    };
  }

  updateViewportHeight(viewportHeight: number) {
    const next = Math.max(1, Math.ceil(viewportHeight));
    if (
      this.#disposed
      || typeof IntersectionObserver === "undefined"
      || next === this.#viewportHeight
    ) {
      return;
    }
    this.#viewportHeight = next;
    if (this.#records.size === 0) return;
    for (const observer of this.#observers.values()) observer.disconnect();
    this.#observers.clear();
    this.#createObservers();
    for (const target of this.#records.keys()) {
      for (const observer of this.#observers.values()) {
        observer.observe(target);
      }
    }
  }

  targetCount() {
    return this.#records.size;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const observer of this.#observers.values()) observer.disconnect();
    this.#observers.clear();
    this.#records.clear();
  }

  #createObservers() {
    if (typeof IntersectionObserver === "undefined") return;
    for (const kind of observerKinds) {
      const observer = new IntersectionObserver((entries) => {
        if (this.#disposed || this.#observers.get(kind) !== observer) return;
        for (const entry of entries) {
          const record = this.#records.get(entry.target);
          if (!record) continue;
          const next = {
            ...record.state,
            [kind]: entry.isIntersecting
          };
          if (equalVisibility(record.state, next)) continue;
          record.state = next;
          record.listener(next);
        }
      }, {
        rootMargin: visibilityRootMargin(kind, this.#viewportHeight)
      });
      this.#observers.set(kind, observer);
    }
  }
}
