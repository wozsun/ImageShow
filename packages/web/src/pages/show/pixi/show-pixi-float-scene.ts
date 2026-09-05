import { Container, type Renderer } from "pixi.js";
import type { ShowOrder } from "@imageshow/shared/browser";
import { shuffledShowImages } from "../show-data-pool.js";
import type { ShowImage } from "../show-layout.js";
import {
  ShowPixiCard,
  ShowPixiPerspectiveCoordinator,
  showPixiTextureLod
} from "./show-pixi-card.js";
import {
  clampShowFloatSizeIndex,
  showFloatDefaultWidth,
  showFloatSizeSteps
} from "./show-pixi-layout.js";
import type {
  ShowPixiTextureCache,
  ShowPixiTextureLease
} from "./show-pixi-texture-cache.js";
import type {
  ShowPixiSceneController,
  ShowPixiSceneOptions,
  ShowPixiSceneStats,
  ShowPixiVisibleItem
} from "./show-pixi-types.js";

type FloatSceneOptions = ShowPixiSceneOptions & {
  inputElement: HTMLElement;
  onManualVerticalMovement: (delta: number, pointerType?: string) => void;
  onSizeIndexChange: (index: number) => number;
  sizeIndex: number;
  speed: number;
  textureCache: ShowPixiTextureCache;
};

type FloatCardState = {
  card: ShowPixiCard;
  drift: number;
  driftRate: number;
  entryOffset: number;
  phase: number;
  rotationPhase: number;
  rotationRate: number;
  hoverRotationFrom: number | null;
  hoverRotationElapsed: number;
  speed: number;
  widthFactor: number;
  x: number;
  xRatio: number;
  velocityX: number;
  y: number;
  targetY: number | null;
  retiring: boolean;
};

type FloatStreamDirection = -1 | 1;

type FloatImagePlan = {
  image: ShowImage;
  serial: number;
  widthFactor: number;
  textureKey: string;
  lease: ShowPixiTextureLease | null;
};

const goldenRatioConjugate = 0.6180339887498949;
const dragFriction = 0.9;
const minimumDragVelocity = 0.018;
const wheelScrollResponseMs = 86;
const wheelScrollStopDistance = 0.08;
const floatRotationAmplitude = 3 * Math.PI / 180;
const floatHoverStraightenMs = 240;
const floatMinimumWidthFactor = 0.5;
const floatMaximumWidthFactor = 1.3;
const floatMeanWidthSquared = (
  floatMinimumWidthFactor ** 2
  + floatMinimumWidthFactor * floatMaximumWidthFactor
  + floatMaximumWidthFactor ** 2
) / 3;

function floatWidthFactor(serial: number) {
  // Spread sizes through every short sequence, including the upcoming texture
  // leases, so large images keep smaller companions across the whole stream.
  const position = (serial * goldenRatioConjugate + 0.5) % 1;
  return floatMinimumWidthFactor
    + position * (floatMaximumWidthFactor - floatMinimumWidthFactor);
}

function noise(value: number, salt: number) {
  const raw = Math.sin(value * 127.1 + salt * 311.7) * 43_758.5453;
  return raw - Math.floor(raw);
}

function imageRatio(image: ShowImage) {
  if (image.width <= 0 || image.height <= 0) return 1;
  return Math.min(1.9, Math.max(0.56, image.height / image.width));
}

function floatCardFootprint(
  width: number,
  height: number,
  rotation: number,
  drift: number
) {
  const maximumRotation = Math.abs(rotation) + floatRotationAmplitude;
  const cosine = Math.abs(Math.cos(maximumRotation));
  const sine = Math.abs(Math.sin(maximumRotation));
  return {
    width: width * cosine + height * sine + drift * 2 + 12,
    height: height * cosine + width * sine + 12
  };
}

function rectanglesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number }
) {
  const overlapWidth = Math.max(0, Math.min(
    left.x + left.width / 2,
    right.x + right.width / 2
  ) - Math.max(
    left.x - left.width / 2,
    right.x - right.width / 2
  ));
  const overlapHeight = Math.max(0, Math.min(
    left.y + left.height / 2,
    right.y + right.height / 2
  ) - Math.max(
    left.y - left.height / 2,
    right.y - right.height / 2
  ));
  return overlapWidth * overlapHeight;
}

export class ShowPixiFloatScene implements ShowPixiSceneController {
  readonly kind = "float" as const;
  readonly root = new Container();
  readonly #perspectiveCoordinator = new ShowPixiPerspectiveCoordinator();
  readonly #textureCache: ShowPixiTextureCache;
  readonly #renderer: Renderer;
  readonly #inputElement: HTMLElement;
  readonly #onManualVerticalMovement: (delta: number, pointerType?: string) => void;
  readonly #onSizeIndexChange: (index: number) => number;
  readonly #onNeedImages: () => void;
  readonly #onOpen: (image: ShowImage, key: string) => void;
  readonly #onVisibleItems: (items: readonly ShowPixiVisibleItem[]) => void;
  readonly #cards: FloatCardState[] = [];
  readonly #prefetchQueues: Record<FloatStreamDirection, FloatImagePlan[]> = {
    [-1]: [],
    [1]: []
  };
  readonly #handlePointerDown = (event: PointerEvent) => {
    if (!this.#inputEnabled || this.#dragPointerId !== null) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    this.#dragPointerId = event.pointerId;
    this.#dragPointerType = event.pointerType;
    this.#dragLastY = this.#eventY(event.clientY);
    this.#dragLastAt = event.timeStamp;
    this.#dragVelocityY = 0;
    this.#wheelScrollRemainingY = 0;
    this.#dragging = true;
    try {
      this.#inputElement.setPointerCapture?.(event.pointerId);
    } catch {
      // A detached canvas or a synthetic event may reject capture.
    }
    if (event.cancelable) event.preventDefault();
  };
  readonly #handlePointerMove = (event: PointerEvent) => {
    if (
      !this.#inputEnabled
      || !this.#dragging
      || event.pointerId !== this.#dragPointerId
    ) return;
    const nextY = this.#eventY(event.clientY);
    const elapsed = Math.min(64, Math.max(1, event.timeStamp - this.#dragLastAt));
    const requestedDelta = nextY - this.#dragLastY;
    const appliedDelta = this.#applyVerticalDrag(requestedDelta, this.#dragPointerType);
    const sampledVelocity = appliedDelta / elapsed;
    if (sampledVelocity * this.#dragVelocityY < 0) this.#dragVelocityY = 0;
    const blend = Math.min(0.72, elapsed / 32);
    this.#dragVelocityY += (
      sampledVelocity - this.#dragVelocityY
    ) * blend;
    if (Math.abs(appliedDelta - requestedDelta) > 0.01) {
      this.#dragVelocityY = 0;
    }
    this.#dragLastY = nextY;
    this.#dragLastAt = event.timeStamp;
    if (event.cancelable) event.preventDefault();
  };
  readonly #handlePointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.#dragPointerId) return;
    this.#releasePointer(event.pointerId);
    this.#dragPointerId = null;
    this.#dragging = false;
    if (this.#reducedMotion) this.#dragVelocityY = 0;
    if (event.cancelable) event.preventDefault();
  };
  readonly #handleWheel = (event: WheelEvent) => {
    if (!this.#inputEnabled) return;
    const normalizedDelta = event.deltaY * (
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? this.#height
          : 1
    );
    if (!Number.isFinite(normalizedDelta) || normalizedDelta === 0) return;
    this.#dragVelocityY = 0;
    if (event.ctrlKey) {
      this.#wheelScrollRemainingY = 0;
      this.#wheelSizeAccumulator = Math.max(-240, Math.min(
        240,
        this.#wheelSizeAccumulator + normalizedDelta
      ));
      if (
        Math.abs(this.#wheelSizeAccumulator) >= 48
        && event.timeStamp - this.#lastWheelSizeAt >= 140
      ) {
        const direction = this.#wheelSizeAccumulator < 0 ? 1 : -1;
        const requested = clampShowFloatSizeIndex(this.#sizeIndex + direction);
        const next = clampShowFloatSizeIndex(
          this.#onSizeIndexChange(requested)
        );
        this.setSizeIndex(next);
        this.#wheelSizeAccumulator = 0;
        this.#lastWheelSizeAt = event.timeStamp;
      }
    } else {
      this.#wheelSizeAccumulator = 0;
      const nextDelta = -Math.max(-360, Math.min(360, normalizedDelta));
      // A reversal starts in the requested direction without first paying
      // off the old wheel remainder.
      if (nextDelta * this.#wheelScrollRemainingY < 0) this.#wheelScrollRemainingY = 0;
      const maximumPending = Math.max(480, this.#height * 1.25);
      this.#wheelScrollRemainingY = Math.max(-maximumPending, Math.min(
        maximumPending,
        this.#wheelScrollRemainingY + nextDelta
      ));
    }
    if (event.cancelable) event.preventDefault();
  };
  #images: ShowImage[] = [];
  #meanImageRatio = 1;
  #imageCursor = 0;
  #width: number;
  #height: number;
  #sizeIndex: number;
  #speed: number;
  #running: boolean;
  #reducedMotion: boolean;
  #dataKey = "";
  #order: ShowOrder = "random";
  #serial = 0;
  #streamDirection: FloatStreamDirection = -1;
  #elapsed = 0;
  #lifecycleElapsed = 0;
  #nextSpawnAt = 0;
  #nextPathAt = 0;
  #nextSpacingAt = 0;
  #pathCursor = 0;
  #nextVisibleAt = 0;
  #lastVisibleSignature = "";
  #recycledSprites = 0;
  #rejectedSprites = 0;
  #layoutRevision = 0;
  #inputEnabled = true;
  #dragPointerId: number | null = null;
  #dragPointerType = "";
  #dragLastY = 0;
  #dragLastAt = 0;
  #dragVelocityY = 0;
  #dragging = false;
  #wheelScrollRemainingY = 0;
  #wheelSizeAccumulator = 0;
  #lastWheelSizeAt = Number.NEGATIVE_INFINITY;
  #inputListenerCount = 0;
  #destroyed = false;

  constructor(options: FloatSceneOptions) {
    this.#textureCache = options.textureCache;
    this.#renderer = options.renderer;
    this.#inputElement = options.inputElement;
    this.#onManualVerticalMovement = options.onManualVerticalMovement;
    this.#onSizeIndexChange = options.onSizeIndexChange;
    this.#onNeedImages = options.onNeedImages;
    this.#onOpen = options.onOpen;
    this.#onVisibleItems = options.onVisibleItems;
    this.#width = Math.max(1, options.width);
    this.#height = Math.max(1, options.height);
    this.#sizeIndex = clampShowFloatSizeIndex(options.sizeIndex);
    this.#speed = options.speed;
    this.#running = options.running;
    this.#reducedMotion = options.reducedMotion;
    this.root.sortableChildren = true;
    this.root.eventMode = "passive";
    this.setImages(options.images, options.dataKey, options.order);
    this.#addInputListeners();
  }

  setSizeIndex(index: number) {
    const next = clampShowFloatSizeIndex(index);
    if (next === this.#sizeIndex) return;
    this.#sizeIndex = next;
    this.#scheduleCountTransition();
    this.#refreshTexturePrefetches();
    this.#layoutRevision += 1;
  }

  setSpeed(speed: number) {
    this.#speed = Math.max(0, Number.isFinite(speed) ? speed : 0);
  }

  resize(width: number, height: number) {
    const previousWidth = this.#width;
    const previousHeight = this.#height;
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);
    for (const state of this.#cards) {
      state.y = previousHeight > 0
        ? state.y / previousHeight * this.#height
        : state.y;
      state.x = previousWidth > 0
        ? state.x / previousWidth * this.#width
        : state.xRatio * this.#width;
      state.card.root.x = state.x;
      state.card.root.y = state.y;
      this.#retargetSize(state);
    }
    if (Math.abs(previousWidth - this.#width) > 1) {
      this.#settleHorizontalDistribution();
    }
    this.#scheduleCountTransition();
    this.#refreshTexturePrefetches();
    this.#layoutRevision += 1;
  }

  setImages(images: readonly ShowImage[], dataKey: string, order: ShowOrder) {
    this.#lastVisibleSignature = "";
    const replacing = dataKey !== this.#dataKey || order !== this.#order;
    const incoming = new Map(images.map((image) => [image.id, image]));
    // Preserve the current random candidate order on append/metadata updates.
    // Reshuffling all 800 DTOs before taking 500 would evict visible cards.
    const retained = order === "random" && !replacing
      ? this.#images.flatMap((image) => {
        const updated = incoming.get(image.id);
        incoming.delete(image.id);
        return updated ? [updated] : [];
      })
      : [];
    const additions = [...incoming.values()];
    const nextImages = [
      ...retained,
      ...(order === "random" ? shuffledShowImages(additions) : additions)
    ].slice(0, 500);
    this.#dataKey = dataKey;
    this.#order = order;
    const previousCursor = this.#imageCursor;
    this.#images = nextImages;
    this.#meanImageRatio = nextImages.length
      ? nextImages.reduce((total, image) => total + imageRatio(image), 0) / nextImages.length
      : 1;
    this.#imageCursor = replacing || !nextImages.length
      ? 0
      : previousCursor % nextImages.length;
    if (replacing) {
      this.#cancelVerticalInput();
      this.#clearTexturePrefetches();
      for (const state of this.#cards) {
        state.card.root.parent?.removeChild(state.card.root);
        state.card.destroy();
      }
      this.#cards.length = 0;
      this.#serial = 0;
      this.#streamDirection = -1;
    } else {
      const imageMap = new Map(nextImages.map((image) => [image.id, image]));
      for (const direction of [-1, 1] as const) {
        this.#prefetchQueues[direction] = this.#prefetchQueues[direction].filter((plan) => {
          const nextImage = imageMap.get(plan.image.id);
          if (!nextImage) {
            this.#releaseImagePlan(plan);
            return false;
          }
          plan.image = nextImage;
          return true;
        });
      }
      if (!imageMap.size) {
        for (const state of this.#cards) {
          state.card.root.parent?.removeChild(state.card.root);
          state.card.destroy();
        }
        this.#cards.length = 0;
      }
      for (const state of this.#cards) {
        const currentId = state.card.image?.id;
        const nextImage = currentId ? imageMap.get(currentId) : undefined;
        if (!nextImage) {
          this.#assignState(state, false);
          this.#recycledSprites += 1;
          continue;
        }
        const width = this.#cardWidth(state);
        state.card.assign(
          state.card.key,
          nextImage,
          width,
          width * imageRatio(nextImage),
          state.card.baseRotation,
          true
        );
        this.#applyCardTransform(state);
      }
    }
    if (!this.#cards.length) this.#fillInitialComposition();
    if (this.#images.length < 96) this.#onNeedImages();
    this.#refreshTexturePrefetches();
    this.#layoutRevision += 1;
  }

  setInputEnabled(enabled: boolean) {
    this.#inputEnabled = enabled;
    if (!enabled) this.#cancelVerticalInput();
    for (const state of this.#cards) {
      state.card.setInteractionEnabled(enabled && !state.retiring);
    }
  }

  setMotion(running: boolean, reducedMotion: boolean) {
    this.#running = running;
    this.#reducedMotion = reducedMotion;
  }

  focusCard(key: string | null) {
    for (const state of this.#cards) {
      state.card.setFocused(state.card.key === key);
    }
  }

  clearPointerHover() {
    for (const state of this.#cards) state.card.clearPointerHover();
  }

  update(elapsedMs: number) {
    if (this.#destroyed) return;
    const elapsed = Math.min(48, Math.max(0, elapsedMs));
    const manualMovement = this.#hasManualMovement();
    if (
      this.#inputEnabled
      && !this.#dragging
      && Math.abs(this.#wheelScrollRemainingY) >= wheelScrollStopDistance
    ) {
      const progress = 1 - Math.exp(-elapsed / wheelScrollResponseMs);
      const requestedDelta = this.#wheelScrollRemainingY * progress;
      const appliedDelta = this.#applyVerticalDrag(requestedDelta);
      this.#wheelScrollRemainingY -= appliedDelta;
      if (
        Math.abs(appliedDelta - requestedDelta) > 0.01
        || Math.abs(this.#wheelScrollRemainingY) < wheelScrollStopDistance
      ) {
        if (Math.abs(appliedDelta - requestedDelta) <= 0.01) {
          this.#applyVerticalDrag(this.#wheelScrollRemainingY);
        }
        this.#wheelScrollRemainingY = 0;
      }
    } else if (!this.#dragging) {
      this.#wheelScrollRemainingY = 0;
    }
    if (
      this.#inputEnabled
      && !this.#dragging
      && !this.#reducedMotion
      && Math.abs(this.#dragVelocityY) >= minimumDragVelocity
    ) {
      const requestedDelta = this.#dragVelocityY * elapsed;
      const appliedDelta = this.#applyVerticalDrag(requestedDelta, this.#dragPointerType);
      if (Math.abs(appliedDelta - requestedDelta) > 0.01) {
        this.#dragVelocityY = 0;
      } else {
        const decay = dragFriction ** (elapsed / (1_000 / 60));
        this.#dragVelocityY *= decay;
      }
    } else if (!this.#dragging) {
      this.#dragVelocityY = 0;
    }
    const moving = this.#running && !this.#reducedMotion && !manualMovement;
    if (moving) this.#setStreamDirection(-1);
    this.#lifecycleElapsed += elapsed;
    if (moving) this.#elapsed += elapsed;
    for (let index = this.#cards.length - 1; index >= 0; index -= 1) {
      const state = this.#cards[index];
      const opacityStep = elapsed / 400;
      state.card.root.alpha = state.retiring
        ? Math.max(0, state.card.root.alpha - opacityStep)
        : Math.min(1, state.card.root.alpha + opacityStep);
      if (state.retiring && state.card.root.alpha === 0) {
        this.#removeCard(index);
        continue;
      }
      // Hover/focus owns this card's motion lease: keep it fixed while the
      // shared stream continues moving around it. Releasing the card resumes
      // from the exact frozen position without resetting its lifecycle. Planar
      // rotation can still ease upright while the pointer owns the card.
      if (moving && !state.card.isInteractionActive) {
        const distance = this.#verticalSpeed(state) * elapsed / 1_000;
        state.y -= distance;
        if (state.targetY !== null) state.targetY -= distance;
        state.phase += state.driftRate * elapsed;
        state.rotationPhase += state.rotationRate * elapsed;
        this.#advanceHorizontalMotion(state, elapsed);
      } else {
        state.velocityX = 0;
      }
      if (!manualMovement && !state.card.isInteractionActive && state.targetY !== null) {
        const progress = this.#reducedMotion ? 1 : 1 - Math.exp(-elapsed / 900);
        state.y += (state.targetY - state.y) * progress;
        if (Math.abs(state.targetY - state.y) < 0.1) state.targetY = null;
      }
      this.#straightenHoveredCard(state, elapsed);
      this.#applyCardTransform(state);
      state.card.update(elapsed, true);
      const buffer = Math.max(72, state.card.height * 0.35);
      const onScreen = state.y + state.card.height / 2 >= -buffer
        && state.y - state.card.height / 2 <= this.#height + buffer;
      state.card.setVisible(onScreen);
    }
    if (moving) this.#recycleOutsideStream();
    if (
      this.#cards.length < this.#targetCount()
      && this.#lifecycleElapsed >= this.#nextSpawnAt
    ) {
      const state = this.#spawn(false);
      if (state) {
        if (moving || manualMovement) {
          state.y = this.#chooseStreamY(
            state.card.targetHeight, state.entryOffset, this.#serial, state, false
          );
          const placement = this.#choosePlacement(
            this.#serial, state.card.targetWidth, state.card.targetHeight, state.y, state
          );
          state.xRatio = placement.xRatio;
          state.x = state.xRatio * this.#width;
          this.#applyCardTransform(state);
        } else {
          this.#placeStaticState(state);
        }
        state.card.root.alpha = 0;
        this.#refreshTexturePrefetches();
      }
      this.#nextSpawnAt = this.#lifecycleElapsed + 120;
    }
    if (moving && this.#elapsed >= this.#nextPathAt) {
      this.#adjustHorizontalPath();
      this.#nextPathAt = this.#elapsed + 80;
    }
    if (moving && this.#elapsed >= this.#nextSpacingAt) {
      this.#balanceFlowSpacing();
      this.#nextSpacingAt = this.#elapsed + 500;
    }
    if (this.#lifecycleElapsed >= this.#nextVisibleAt) {
      this.#publishVisibleItems();
      this.#nextVisibleAt = this.#lifecycleElapsed + 250;
    }
  }

  stats(): ShowPixiSceneStats {
    const visible = this.#cards.filter((state) => state.card.visible);
    const composition = this.#compositionMetrics(visible);
    const visibleSprites = visible.length;
    const meanY = this.#cards.length
      ? this.#cards.reduce((total, state) => total + state.y, 0) / this.#cards.length
      : 0;
    const horizontalBuckets = new Array<number>(8).fill(0);
    for (const state of visible) {
      const bucket = Math.min(7, Math.max(0, Math.floor(
        state.card.root.x / this.#width * horizontalBuckets.length
      )));
      horizontalBuckets[bucket] += 1;
    }
    const horizontalConcentration = visibleSprites
      ? Math.max(...horizontalBuckets) / visibleSprites
      : 0;
    return {
      activeSprites: this.#cards.length,
      visibleSprites,
      retainedDtos: this.#images.length,
      recycledSprites: this.#recycledSprites,
      rejectedSprites: this.#rejectedSprites,
      ...composition,
      horizontalConcentration,
      layoutRevision: this.#layoutRevision,
      inputEnabled: this.#inputEnabled,
      inputListenerCount: this.#inputListenerCount,
      activePointers: this.#dragPointerId === null ? 0 : 1,
      waterfallColumns: null,
      waterfallCameraX: null,
      waterfallCameraY: null,
      waterfallScale: null,
      floatSizeIndex: this.#sizeIndex,
      floatMeanY: meanY
    };
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#cancelVerticalInput();
    this.#removeInputListeners();
    this.#clearTexturePrefetches();
    this.#onVisibleItems([]);
    for (const state of this.#cards) state.card.destroy();
    this.#cards.length = 0;
    this.#images = [];
    this.root.removeAllListeners();
    this.root.destroy({ children: true });
  }

  #addInputListeners() {
    this.#inputElement.addEventListener(
      "pointerdown",
      this.#handlePointerDown,
      { passive: false }
    );
    this.#inputElement.addEventListener(
      "pointermove",
      this.#handlePointerMove,
      { passive: false }
    );
    this.#inputElement.addEventListener(
      "pointerup",
      this.#handlePointerUp,
      { passive: false }
    );
    this.#inputElement.addEventListener(
      "pointercancel",
      this.#handlePointerUp,
      { passive: false }
    );
    this.#inputElement.addEventListener(
      "lostpointercapture",
      this.#handlePointerUp,
      { passive: false }
    );
    this.#inputElement.addEventListener("wheel", this.#handleWheel, {
      passive: false
    });
    this.#inputListenerCount = 6;
  }

  #applyVerticalDrag(requestedDelta: number, pointerType?: string) {
    if (!Number.isFinite(requestedDelta) || requestedDelta === 0) return 0;
    if (!this.#cards.length) return 0;
    this.#setStreamDirection(requestedDelta < 0 ? -1 : 1);
    // Advance the retained stream in bounded spatial steps. Even a large
    // pointer delta replenishes the incoming band before moving through it.
    const maximumStep = Math.max(32, Math.min(128, this.#streamBuffer() * 0.25));
    const steps = Math.ceil(Math.abs(requestedDelta) / maximumStep);
    const delta = requestedDelta / steps;
    for (let step = 0; step < steps; step += 1) {
      for (const state of this.#cards) {
        state.y += delta;
        // A prior size transition must not pull a manually moved card back.
        state.targetY = null;
      }
      this.#recycleOutsideStream();
    }
    this.#onManualVerticalMovement(-requestedDelta, pointerType);
    return requestedDelta;
  }

  #hasManualMovement() {
    return this.#inputEnabled && (
      this.#dragging
      || Math.abs(this.#wheelScrollRemainingY) >= wheelScrollStopDistance
      || (!this.#reducedMotion && Math.abs(this.#dragVelocityY) >= minimumDragVelocity)
    );
  }

  #setStreamDirection(direction: FloatStreamDirection) {
    if (this.#streamDirection === direction) return;
    this.#streamDirection = direction;
    const incoming: FloatCardState[] = [];
    const outgoing: FloatCardState[] = [];
    let totalHeight = 0;
    let activeCount = 0;
    for (const state of this.#cards) {
      if (state.retiring) continue;
      activeCount += 1;
      totalHeight += state.card.targetHeight;
      if (state.card.isInteractionActive) continue;
      const footprint = floatCardFootprint(
        Math.max(state.card.width, state.card.targetWidth),
        Math.max(state.card.height, state.card.targetHeight),
        state.card.baseRotation,
        state.drift
      );
      const above = state.y + footprint.height / 2 < -24;
      const below = state.y - footprint.height / 2 > this.#height + 24;
      if (!above && !below) continue;
      ((direction < 0 ? below : above) ? incoming : outgoing).push(state);
    }
    const meanHeight = totalHeight / Math.max(1, activeCount);
    const bufferQuota = Math.ceil(
      this.#targetCount() * this.#streamBuffer()
      / (this.#height + this.#streamBuffer() * 2 + meanHeight)
    );
    // Keep reserves at both ends. Rebalance only fully off-screen cards,
    // preferring already decoded textures and leaving visible cards intact.
    const reserve = Math.min(bufferQuota, Math.floor((incoming.length + outgoing.length) / 2));
    const needed = reserve - incoming.length;
    if (needed <= 0) return;
    outgoing.sort((left, right) => {
      const readiness = Number(right.card.isTextureReady) - Number(left.card.isTextureReady);
      return readiness || (direction < 0 ? left.y - right.y : right.y - left.y);
    });
    for (const state of outgoing.slice(0, needed)) {
      state.targetY = null;
      const height = Math.max(state.card.height, state.card.targetHeight);
      state.y = this.#chooseStreamY(height, state.entryOffset, this.#serial, state, true, direction);
      const placement = this.#choosePlacement(
        this.#serial,
        Math.max(state.card.width, state.card.targetWidth),
        height,
        state.y,
        state
      );
      state.xRatio = placement.xRatio;
      state.x = state.xRatio * this.#width;
      state.velocityX = 0;
      this.#applyCardTransform(state);
      this.#layoutRevision += 1;
    }
  }

  #recycleOutsideStream() {
    let recycled = false;
    for (let index = this.#cards.length - 1; index >= 0; index -= 1) {
      const state = this.#cards[index];
      const direction: FloatStreamDirection | null = state.y < this.#exitBoundary(state)
        ? -1
        : state.y > this.#entryBoundary(state) ? 1 : null;
      if (direction === null) continue;
      if (state.retiring && this.#cards.length > this.#targetCount()) {
        this.#removeCard(index);
      } else {
        this.#assignState(state, false, direction);
        this.#recycledSprites += 1;
      }
      recycled = true;
    }
    if (recycled) {
      this.#refreshTexturePrefetches();
      if (this.#images.length < 96) this.#onNeedImages();
    }
  }

  #cancelVerticalInput() {
    if (this.#dragPointerId !== null) {
      this.#releasePointer(this.#dragPointerId);
    }
    this.#dragPointerId = null;
    this.#dragging = false;
    this.#dragVelocityY = 0;
    this.#wheelScrollRemainingY = 0;
    this.#wheelSizeAccumulator = 0;
  }

  #eventY(clientY: number) {
    const bounds = this.#inputElement.getBoundingClientRect();
    const scale = bounds.height > 0 ? this.#height / bounds.height : 1;
    return (clientY - bounds.top) * scale;
  }

  #releasePointer(pointerId: number) {
    try {
      if (this.#inputElement.hasPointerCapture?.(pointerId)) {
        this.#inputElement.releasePointerCapture?.(pointerId);
      }
    } catch {
      // Capture may already be gone after visibility or scene changes.
    }
  }

  #removeInputListeners() {
    this.#inputElement.removeEventListener(
      "pointerdown",
      this.#handlePointerDown
    );
    this.#inputElement.removeEventListener(
      "pointermove",
      this.#handlePointerMove
    );
    this.#inputElement.removeEventListener("pointerup", this.#handlePointerUp);
    this.#inputElement.removeEventListener(
      "pointercancel",
      this.#handlePointerUp
    );
    this.#inputElement.removeEventListener(
      "lostpointercapture",
      this.#handlePointerUp
    );
    this.#inputElement.removeEventListener("wheel", this.#handleWheel);
    this.#inputListenerCount = 0;
  }

  #fillInitialComposition() {
    if (!this.#images.length) return;
    const count = this.#targetCount();
    for (let index = 0; index < count; index += 1) {
      const state = this.#spawn(true);
      if (!state) break;
      if (this.#reducedMotion) {
        this.#placeStaticState(state);
        continue;
      }
      const exitBoundary = this.#exitBoundary(state);
      const entryBoundary = this.#entryBoundary(state);
      state.y = exitBoundary + (
        (index + 0.4 + noise(index, 19) * 0.2) / count
      ) * (entryBoundary - exitBoundary);
      const placement = this.#choosePlacement(
        index + this.#serial,
        state.card.targetWidth,
        state.card.targetHeight,
        state.y,
        state,
        (entryBoundary - exitBoundary) / count * 0.3
      );
      state.xRatio = placement.xRatio;
      state.y = placement.y;
      state.x = state.xRatio * this.#width;
      this.#applyCardTransform(state);
    }
    this.#settleHorizontalDistribution();
    this.#publishVisibleItems();
  }

  #spawn(initial: boolean) {
    if (!this.#images.length || this.#cards.length >= this.#maximumCards()) {
      if (this.#images.length) this.#rejectedSprites += 1;
      return null;
    }
    const card = new ShowPixiCard(
      this.#textureCache,
      this.#onOpen,
      this.#renderer,
      this.#perspectiveCoordinator
    );
    card.setInteractionEnabled(this.#inputEnabled);
    const state: FloatCardState = {
      card,
      drift: 0,
      driftRate: 0,
      entryOffset: 24,
      phase: 0,
      rotationPhase: 0,
      rotationRate: 0,
      hoverRotationFrom: null,
      hoverRotationElapsed: 0,
      speed: 0,
      widthFactor: 1,
      x: this.#width / 2,
      xRatio: 0.5,
      velocityX: 0,
      y: this.#height,
      targetY: null,
      retiring: false
    };
    this.#cards.push(state);
    this.root.addChild(card.root);
    this.#assignState(state, initial);
    return state;
  }

  #assignState(
    state: FloatCardState,
    initial: boolean,
    direction: FloatStreamDirection = this.#streamDirection
  ) {
    const plan = (initial ? null : this.#prefetchQueues[direction].shift())
      ?? this.#createImagePlan();
    if (!plan) return;
    const { image, serial, widthFactor } = plan;
    state.widthFactor = widthFactor;
    state.phase = noise(serial, 4) * Math.PI * 2;
    state.drift = 6 + noise(serial, 5) * 10;
    state.driftRate = 0.0001 + noise(serial, 6) * 0.00008;
    state.rotationPhase = noise(serial, 12) * Math.PI * 2;
    state.rotationRate = Math.PI * 2 / (24_000 + noise(serial, 13) * 16_000);
    state.hoverRotationFrom = null;
    state.hoverRotationElapsed = 0;
    state.velocityX = 0;
    // Start near the configured speed; spacing feedback gently adjusts it
    // during the journey so neighboring cards do not remain locked together.
    state.speed = 28 + (noise(serial, 7) - 0.5) * 0.08;
    state.entryOffset = 24
      + noise(serial, 10) * Math.min(20, this.#height * 0.025);
    state.retiring = false;
    state.targetY = null;
    state.card.root.alpha = 1;
    state.card.setInteractionEnabled(this.#inputEnabled);
    const width = this.#cardWidth(state);
    const height = width * imageRatio(image);
    state.card.assign(
      `float:${serial}`,
      image,
      width,
      height,
      (noise(serial, 11) - 0.5) * 0.17,
      false,
      width
    );
    // The card acquires the same image/size lease before prefetch releases it.
    this.#releaseImagePlan(plan);
    state.y = initial
      ? noise(serial, 9) * this.#height
      : this.#chooseStreamY(height, state.entryOffset, serial, state, true, direction);
    state.xRatio = initial
      ? 0.5
      : this.#choosePlacement(serial, width, height, state.y, state).xRatio;
    state.x = state.xRatio * this.#width;
    this.#applyCardTransform(state);
    state.card.setVisible(true);
    this.#layoutRevision += 1;
  }

  #retargetSize(state: FloatCardState) {
    const image = state.card.image;
    if (!image) return;
    const width = this.#cardWidth(state);
    state.card.assign(
      state.card.key,
      image,
      width,
      width * imageRatio(image),
      state.card.baseRotation,
      true,
      width
    );
    this.#applyCardTransform(state);
  }

  #straightenHoveredCard(state: FloatCardState, elapsed: number) {
    if (!state.card.isHovered) {
      state.hoverRotationFrom = null;
      state.hoverRotationElapsed = 0;
      return;
    }
    const swing = this.#reducedMotion ? 0 : Math.sin(state.rotationPhase) * floatRotationAmplitude;
    if (state.hoverRotationFrom === null) {
      state.hoverRotationFrom = state.card.baseRotation + swing;
    }
    state.hoverRotationElapsed = Math.min(floatHoverStraightenMs, state.hoverRotationElapsed + elapsed);
    const progress = this.#reducedMotion ? 1 : state.hoverRotationElapsed / floatHoverStraightenMs;
    const angle = state.hoverRotationFrom * (1 - progress) ** 3;
    // Rebase the existing oscillator instead of returning to the old static
    // tilt on release. Even an interrupted straighten resumes at its current
    // angle, preserving the rotation phase, speed and three-degree amplitude.
    state.card.baseRotation = angle - swing;
  }

  #applyCardTransform(state: FloatCardState) {
    state.card.root.position.set(state.x, state.y);
    state.card.root.rotation = state.card.baseRotation + (
      this.#reducedMotion ? 0 : Math.sin(state.rotationPhase) * floatRotationAmplitude
    );
  }

  #advanceHorizontalMotion(state: FloatCardState, elapsed: number) {
    const targetX = state.xRatio * this.#width + Math.sin(state.phase) * state.drift;
    const driftVelocity = Math.cos(state.phase) * state.drift * state.driftRate * 1_000;
    const maximumVelocity = Math.min(10, Math.max(4, state.card.targetWidth * 0.015));
    const desiredVelocity = Math.max(-maximumVelocity, Math.min(
      maximumVelocity, (targetX - state.x) / 4 + driftVelocity
    ));
    // Steer velocity continuously instead of rapidly chasing each new anchor.
    // Each card owns its phases, so releasing hover/focus has no time catch-up.
    const previousVelocity = state.velocityX;
    state.velocityX += (desiredVelocity - state.velocityX) * (1 - Math.exp(-elapsed / 1_400));
    state.x += (previousVelocity + state.velocityX) / 2 * elapsed / 1_000;
  }

  #cardWidth(state: FloatCardState) {
    const base = showFloatDefaultWidth(this.#width);
    return base * showFloatSizeSteps[this.#sizeIndex] * state.widthFactor;
  }

  #targetCount() {
    const base = showFloatDefaultWidth(this.#width);
    const size = showFloatSizeSteps[this.#sizeIndex];
    const scaled = base * size;
    // Cover the visible viewport plus the retained half-screen buffers above
    // and below it. This keeps visible density stable while both off-screen
    // bands remain populated and texture-ready. The existing hard Sprite cap
    // still bounds the result at every size.
    const retainedHeight = this.#height + this.#streamBuffer() * 2;
    const densityFactor = this.#width <= 760 ? 0.56 : 0.84;
    // Budget the mixed widths by their mean squared factor. Larger size steps
    // also account for portrait area while retaining small gap-filling cards.
    const portraitFactor = 1 + Math.max(0, this.#meanImageRatio - 1)
      * Math.min(1, Math.max(0, (size - 1) * 2));
    const estimate = Math.round(
      this.#width * retainedHeight / Math.max(
        1, scaled * scaled * floatMeanWidthSquared * portraitFactor
      )
      * densityFactor
    );
    const minimum = this.#width <= 760 ? 6 : 8;
    return Math.min(this.#maximumCards(), Math.max(minimum, estimate));
  }

  #maximumCards() {
    return this.#width <= 760 ? 96 : 180;
  }

  #streamBuffer() {
    return this.#height * 0.5;
  }

  #entryBoundary(state: FloatCardState) {
    return this.#height
      + this.#streamBuffer()
      + Math.max(state.card.height, state.card.targetHeight) / 2;
  }

  #exitBoundary(state: FloatCardState) {
    return -(this.#streamBuffer() + Math.max(state.card.height, state.card.targetHeight) / 2);
  }

  #verticalSpeed(state: FloatCardState) {
    // Keep lifecycle spacing independent of image height. Motion and layout
    // prediction share this speed so placement follows the actual stream.
    const streamDistance = this.#height + this.#streamBuffer() * 2;
    const travelScale = (
      this.#entryBoundary(state) - this.#exitBoundary(state)
    ) / Math.max(1, streamDistance);
    return state.speed * travelScale * this.#speed / 28;
  }

  #chooseStreamY(
    height: number,
    entryOffset: number,
    serial: number,
    ignoredState: FloatCardState,
    bufferOnly = true,
    direction: FloatStreamDirection = this.#streamDirection
  ) {
    const buffer = this.#streamBuffer();
    const footprint = floatCardFootprint(
      Math.max(ignoredState.card.width, ignoredState.card.targetWidth),
      height,
      ignoredState.card.baseRotation,
      ignoredState.drift
    );
    const minimumDepth = Math.min(buffer * 0.4, Math.max(
      entryOffset, (footprint.height - height) / 2 + 24
    ));
    // Keep a margin from the outer recycle boundary so a small reversal does
    // not immediately discard a card that has only just been replenished.
    const outerMargin = Math.min(buffer * 0.25, Math.max(24, buffer * 0.15));
    const exitY = -(buffer + height / 2);
    const travelDistance = this.#height + buffer * 2 + height;
    const endMargin = travelDistance / Math.max(2, this.#targetCount() * 2);
    const minimumY = bufferOnly
      ? this.#height + height / 2 + minimumDepth
      : exitY + endMargin;
    const availableDepth = bufferOnly
      ? Math.max(1, buffer - minimumDepth - outerMargin)
      : Math.max(1, travelDistance - endMargin * 2);
    const phases = this.#cards
      .filter((existing) => existing !== ignoredState && !existing.retiring)
      .map((existing) => {
        const exit = this.#exitBoundary(existing);
        const phase = (existing.y - exit) / (this.#entryBoundary(existing) - exit);
        return ((phase % 1) + 1) % 1;
      });
    let bestY = direction < 0 ? minimumY : this.#height - minimumY;
    let bestGap = -1;
    // Reuse the largest available lifecycle gap instead of injecting each
    // recycled card at an unrelated random phase and forming dense cohorts.
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const depth = (attempt + noise(serial, 53)) / 16 * availableDepth;
      const y = direction < 0 ? minimumY + depth : this.#height - minimumY - depth;
      const phase = (y - exitY) / travelDistance;
      let nearest = 1;
      for (const existing of phases) {
        const distance = Math.abs(phase - existing);
        nearest = Math.min(nearest, distance, 1 - distance);
      }
      if (nearest <= bestGap) continue;
      bestGap = nearest;
      bestY = y;
    }
    return bestY;
  }

  #scheduleCountTransition() {
    const target = this.#targetCount();
    for (const state of this.#cards) this.#retargetSize(state);
    const ordered = [...this.#cards].sort((left, right) => left.y - right.y);
    const retained = new Set(ordered.filter((state) => state.card.isInteractionActive));
    if (this.#cards.length > target) {
      for (let index = 0; index < target && retained.size < target; index += 1) {
        const position = target === 1
          ? Math.floor((ordered.length - 1) / 2)
          : Math.round(index * (ordered.length - 1) / (target - 1));
        retained.add(ordered[position]);
      }
    }
    for (const state of ordered) {
      if (retained.size >= target) break;
      retained.add(state);
    }
    for (const state of this.#cards) {
      state.retiring = !retained.has(state);
      state.targetY = null;
      state.card.setInteractionEnabled(this.#inputEnabled && !state.retiring);
    }
    const survivors = ordered.filter((state) => retained.has(state));
    for (let index = 0; index < survivors.length; index += 1) {
      const state = survivors[index];
      if (state.card.isInteractionActive) continue;
      const exit = this.#exitBoundary(state);
      state.targetY = this.#reducedMotion
        ? (index + 0.5) / survivors.length * this.#height
        : exit + (index + 0.5) / survivors.length * (this.#entryBoundary(state) - exit);
    }
    this.#nextPathAt = this.#elapsed;
    this.#nextSpacingAt = this.#elapsed;
    this.#nextSpawnAt = Math.min(
      this.#nextSpawnAt,
      this.#lifecycleElapsed + 120
    );
  }

  #placeStaticState(state: FloatCardState) {
    const serial = this.#serial + this.#cards.length;
    const halfHeight = state.card.targetHeight / 2;
    const minimumY = Math.min(this.#height / 2, halfHeight + 12);
    const maximumY = Math.max(minimumY, this.#height - halfHeight - 12);
    state.y = minimumY + (
      serial * goldenRatioConjugate + noise(serial, 37)
    ) % 1 * (maximumY - minimumY);
    state.xRatio = this.#choosePlacement(
      serial,
      state.card.targetWidth,
      state.card.targetHeight,
      state.y,
      state
    ).xRatio;
    state.x = state.xRatio * this.#width;
    this.#applyCardTransform(state);
  }

  #removeCard(index: number) {
    const state = this.#cards[index];
    if (!state) return;
    state.card.root.parent?.removeChild(state.card.root);
    state.card.destroy();
    this.#cards.splice(index, 1);
    this.#recycledSprites += 1;
    this.#layoutRevision += 1;
  }

  #createImagePlan(): FloatImagePlan | null {
    if (!this.#images.length) return null;
    const image = this.#images[this.#imageCursor % this.#images.length];
    this.#imageCursor = (this.#imageCursor + 1) % this.#images.length;
    const serial = this.#serial++;
    return {
      image,
      serial,
      widthFactor: floatWidthFactor(serial),
      textureKey: "",
      lease: null
    };
  }

  #refreshTexturePrefetches() {
    const count = this.#images.length
      ? Math.min(this.#width <= 760 ? 18 : 36, Math.max(
        this.#width <= 760 ? 6 : 12,
        Math.ceil(this.#targetCount() / 3)
      ))
      : 0;
    const baseWidth = showFloatDefaultWidth(this.#width)
      * showFloatSizeSteps[this.#sizeIndex];
    const pending: {
      plan: FloatImagePlan;
      textureKey: string;
      lod: ReturnType<typeof showPixiTextureLod>;
    }[] = [];
    // Both directions keep their plans until consumed. The original total
    // budget is split between them rather than duplicated on each reversal.
    for (const direction of [-1, 1] as const) {
      const queue = this.#prefetchQueues[direction];
      const limit = direction < 0 ? Math.ceil(count / 2) : Math.floor(count / 2);
      while (queue.length > limit) this.#releaseImagePlan(queue.pop()!);
      while (queue.length < limit) {
        const plan = this.#createImagePlan();
        if (!plan) break;
        queue.push(plan);
      }
      for (const plan of queue) {
        const { image, widthFactor } = plan;
        const width = baseWidth * widthFactor;
        const ratio = imageRatio(image);
        const lod = showPixiTextureLod(image, width, ratio);
        const textureKey = `${image.id}:${image.thumb_url}:${lod.pixelWidth}x${lod.pixelHeight}`;
        if (plan.textureKey === textureKey && plan.lease) continue;
        this.#releaseImagePlan(plan);
        pending.push({ plan, textureKey, lod });
      }
    }
    // Release obsolete LODs at both ends before acquiring their replacements.
    for (const { plan, textureKey, lod } of pending) {
      plan.textureKey = textureKey;
      plan.lease = this.#textureCache.acquire(plan.image.thumb_url, lod, () => undefined);
    }
  }

  #releaseImagePlan(plan: FloatImagePlan) {
    plan.lease?.release();
    plan.lease = null;
    plan.textureKey = "";
  }

  #clearTexturePrefetches() {
    for (const direction of [-1, 1] as const) {
      const queue = this.#prefetchQueues[direction];
      for (const plan of queue) this.#releaseImagePlan(plan);
      queue.length = 0;
    }
  }

  #choosePlacement(
    serial: number,
    width: number,
    height: number,
    candidateY: number,
    ignoredState: FloatCardState,
    verticalSpread = 0,
    local = false
  ) {
    const footprint = floatCardFootprint(
      width, height, ignoredState.card.baseRotation, ignoredState.drift
    );
    const margin = Math.min(0.5, footprint.width / 2 / this.#width);
    const center = Math.max(margin, Math.min(1 - margin, ignoredState.xRatio));
    const maximumShift = local ? Math.min(0.035, width / this.#width * 0.12) : 1;
    const minimumX = Math.max(margin, center - maximumShift);
    const maximumX = Math.min(1 - margin, center + maximumShift);
    let best = { xRatio: center, y: candidateY };
    let bestScore = Number.POSITIVE_INFINITY;
    const candidateArea = Math.max(1, footprint.width * footprint.height);
    const predictMovement = this.#running && !this.#reducedMotion && !this.#hasManualMovement();
    const candidateSpeed = predictMovement && !ignoredState.card.isInteractionActive
      ? this.#verticalSpeed(ignoredState)
      : 0;
    const existingCards = this.#cards
      .filter((existing) => existing !== ignoredState && !existing.retiring)
      .map((existing) => {
        const targetX = existing.card.isInteractionActive
          ? existing.x : existing.xRatio * this.#width;
        const bounds = floatCardFootprint(
          existing.card.targetWidth,
          existing.card.targetHeight,
          existing.card.baseRotation,
          existing.drift
        );
        return {
          x: (existing.x + targetX) / 2,
          y: existing.y,
          targetY: existing.targetY ?? existing.y,
          width: bounds.width + Math.abs(targetX - existing.x),
          height: bounds.height,
          speed: predictMovement && !existing.card.isInteractionActive
            ? this.#verticalSpeed(existing) : 0,
          bucket: Math.min(5, Math.max(0, Math.floor(existing.xRatio * 6)))
        };
      });
    for (let attempt = 0; attempt < (local ? 13 : 28); attempt += 1) {
      const sequence = (
        serial * goldenRatioConjugate
        + attempt * 0.3819660112501051
        + noise(serial, attempt + 21) * 0.17
      ) % 1;
      const ratio = attempt === 0 ? center : minimumX + sequence * (maximumX - minimumX);
      const y = candidateY + ((attempt + 1) % 3 - 1) * verticalSpread;
      const targetY = ignoredState.targetY ?? y;
      const sampleTimes = [0];
      if (candidateSpeed > 0) {
        const halfHeight = Math.min(this.#height / 2, footprint.height / 2);
        // Check the path while the card can be fully viewed, as well as the
        // near future when adjusting a card that is already on screen.
        for (const centerY of [this.#height - halfHeight, this.#height / 2, halfHeight]) {
          const seconds = (targetY - centerY) / candidateSpeed;
          if (seconds > 0) sampleTimes.push(seconds);
        }
        if (local) sampleTimes.push(3);
      }
      const bucket = Math.min(5, Math.max(0, Math.floor(ratio * 6)));
      let score = local
        ? candidateArea * 0.4 * ((ratio - center) * this.#width / Math.max(1, width)) ** 2
        : 0;
      for (const existing of existingCards) {
        const sharedArea = Math.max(1, Math.min(
          candidateArea,
          existing.width * existing.height
        ));
        for (const seconds of sampleTimes) {
          const overlapArea = rectanglesOverlap({
            x: ratio * this.#width,
            y: targetY - candidateSpeed * seconds + (y - targetY) * Math.exp(-seconds / 0.9),
            ...footprint
          }, {
            ...existing,
            y: existing.targetY - existing.speed * seconds
              + (existing.y - existing.targetY) * Math.exp(-seconds / 0.9)
          });
          if (overlapArea <= 0) continue;
          const occlusionRatio = overlapArea / sharedArea;
          let penalty = overlapArea * (1 + occlusionRatio * 8);
          if (occlusionRatio > 0.32) {
            penalty += candidateArea * (occlusionRatio - 0.32) * 18;
          }
          score += penalty / sampleTimes.length;
        }
        if (existing.bucket === bucket) {
          // Prefer a local opening, rather than treating a card at the other
          // end of the stream as occupying this vertical band too.
          const separation = Math.abs(existing.y - y) / Math.max(height, existing.height);
          score += candidateArea * 0.075 / (1 + separation * separation);
        }
      }
      const minimumImprovement = local && attempt > 0 ? candidateArea * 0.01 : 0;
      if (score >= bestScore - minimumImprovement) continue;
      bestScore = score;
      best = { xRatio: ratio, y };
    }
    return best;
  }

  #settleHorizontalDistribution() {
    for (let index = 0; index < this.#cards.length; index += 1) {
      const state = this.#cards[index];
      state.xRatio = this.#choosePlacement(
        index + this.#serial,
        state.card.targetWidth,
        state.card.targetHeight,
        state.y,
        state
      ).xRatio;
      state.x = state.xRatio * this.#width;
      state.velocityX = 0;
      this.#applyCardTransform(state);
    }
  }

  #adjustHorizontalPath() {
    const count = this.#cards.length;
    if (!count) return;
    const index = this.#pathCursor % count;
    this.#pathCursor = (index + 1) % count;
    const state = this.#cards[index];
    if (state.retiring || state.card.isInteractionActive) return;
    state.xRatio = this.#choosePlacement(
      index + this.#serial,
      state.card.targetWidth,
      state.card.targetHeight,
      state.y,
      state,
      0,
      true
    ).xRatio;
  }

  #balanceFlowSpacing() {
    const ordered = this.#cards
      .filter((state) => !state.retiring)
      .map((state) => {
        const exit = this.#exitBoundary(state);
        const phase = (state.y - exit) / (this.#entryBoundary(state) - exit);
        return { state, phase: ((phase % 1) + 1) % 1 };
      })
      .sort((left, right) => left.phase - right.phase);
    if (ordered.length < 2) return;
    const targetGap = 1 / ordered.length;
    for (let index = 0; index < ordered.length; index += 1) {
      const { state, phase } = ordered[index];
      if (state.card.isInteractionActive || state.targetY !== null) continue;
      const previous = ordered[(index + ordered.length - 1) % ordered.length].phase;
      const next = ordered[(index + 1) % ordered.length].phase;
      const gapAhead = (phase - previous + 1) % 1;
      const gapBehind = (next - phase + 1) % 1;
      const adjustment = Math.max(-0.3, Math.min(
        0.3, (gapAhead - gapBehind) / targetGap * 0.3
      ));
      state.speed += (28 * (1 + adjustment) - state.speed) * 0.2;
    }
  }

  #publishVisibleItems() {
    const items = this.#cards
      .filter((state) => state.card.visible && state.card.image)
      .map((state) => ({
        key: state.card.key,
        image: state.card.image as ShowImage
      }));
    const signature = items.map((item) => `${item.key}:${item.image.id}`).join("|");
    if (signature === this.#lastVisibleSignature) return;
    this.#lastVisibleSignature = signature;
    this.#onVisibleItems(items);
  }

  #compositionMetrics(visible: readonly FloatCardState[]) {
    let totalArea = 0;
    let overlapArea = 0;
    for (let index = 0; index < visible.length; index += 1) {
      const left = visible[index];
      const width = left.card.width;
      const height = left.card.height;
      const clippedWidth = Math.max(0, Math.min(
        this.#width,
        left.card.root.x + width / 2
      ) - Math.max(0, left.card.root.x - width / 2));
      const clippedHeight = Math.max(0, Math.min(
        this.#height,
        left.y + height / 2
      ) - Math.max(0, left.y - height / 2));
      totalArea += clippedWidth * clippedHeight;
      for (let other = index + 1; other < visible.length; other += 1) {
        const right = visible[other];
        overlapArea += rectanglesOverlap({
          x: left.card.root.x,
          y: left.y,
          width,
          height
        }, {
          x: right.card.root.x,
          y: right.y,
          width: right.card.width,
          height: right.card.height
        });
      }
    }
    return {
      coverageRatio: Math.min(1, totalArea / Math.max(1, this.#width * this.#height)),
      overlapRatio: Math.min(1, overlapArea / Math.max(1, totalArea))
    };
  }
}
