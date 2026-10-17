import { imageVariantUrl } from "@imageshow/shared/browser";
import { Container, type Renderer } from "pixi.js";
import type { ShowOrder } from "@imageshow/shared/browser";
import type { ShowCandidateUsage } from "../show-data-pool.js";
import { shuffledImageBatch } from "../../../lib/gallery/image-browse.js";
import type { ShowImage } from "../show-layout.js";
import {
  ShowPixiCard,
  ShowPixiPerspectiveCoordinator,
  showPixiTextureLod
} from "./show-pixi-card.js";
import {
  clampShowFloatSizeIndex,
  showFloatPacking,
  showFloatStepSide,
  showFloatViewingMargin
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
  /** Slot center. Slots move with the stream as one sheet and own spacing. */
  x: number;
  y: number;
  /** Displayed displacement from the slot, easing back to zero. */
  offsetX: number;
  offsetY: number;
  /** Displayed y while hover or focus holds the card in place. */
  heldY: number | null;
  drift: number;
  driftFactor: number;
  driftRate: number;
  phase: number;
  rotationPhase: number;
  rotationRate: number;
  hoverRotationFrom: number | null;
  hoverRotationElapsed: number;
  sizeFactor: number;
  retiring: boolean;
};

type FloatStreamDirection = -1 | 1;

type FloatPinch = {
  /** Client positions of the two fingers. */
  points: Map<number, { x: number; y: number }>;
  /** Finger distance when the size step last changed. */
  distance: number;
  changedAt: number;
};

type FloatImagePlan = {
  image: ShowImage;
  serial: number;
  sizeFactor: number;
  textureKey: string;
  lease: ShowPixiTextureLease | null;
};

type FloatCardGeometry = {
  width: number;
  height: number;
  rotation: number;
  drift: number;
};

type FloatSlotBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const goldenRatioConjugate = 0.6180339887498949;
const dragFriction = 0.9;
const minimumDragVelocity = 0.018;
const wheelScrollResponseMs = 86;
const wheelScrollStopDistance = 0.08;
const floatRotationAmplitude = (3 * Math.PI) / 180;
const floatHoverStraightenMs = 240;
// Card sides vary this much around the size step: enough that the stream does
// not look stamped, without letting single images dominate it.
const floatSizeSpread = 0.12;
// Like the cluster's sphere lattice, spacing is measured between card centers,
// so neighbors overlap a little at corners and edges in every direction instead
// of tiling into touching rows or columns. Offsets are scaled by the pair's
// mean width and height: measuring them in card sides would keep portrait
// cards too far apart side by side and let them press on each other's top and
// bottom edges, which stacks narrow screens into two columns.
const floatMinimumSpacing = 1.1;
// No pair may cover more than this share of the smaller card.
const floatMaximumOverlap = 0.15;
const floatPlacementCandidates = 64;
// Cards may reach this share of their width into the side margins kept for
// rotation and sway, so they can meet the screen edge as cluster cards do.
// Without it a large card on a narrow screen leaves an unusable strip beside it.
const floatSideOverhang = 0.25;
// New cards are placed with their far edge within this many card sides of the
// end of the band that the stream is filling.
const floatPlacementDepth = 0.6;
// The finger distance changes by this ratio for each size step of a pinch;
// pinch steps and Ctrl + wheel steps keep the same minimum interval.
const floatPinchStepRatio = 1.15;
const floatSizeStepIntervalMs = 140;
const floatSettleMs = 650;
const floatSettleSpeed = 480;
const floatSpawnIntervalMs = 100;

function floatSizeFactor(serial: number) {
  // Spread sizes through every short sequence, including the upcoming texture
  // leases, so a run of large images still gets smaller companions.
  const position = (serial * goldenRatioConjugate + 0.5) % 1;
  return 1 + floatSizeSpread * (position * 2 - 1);
}

function noise(value: number, salt: number) {
  const raw = Math.sin(value * 127.1 + salt * 311.7) * 43_758.5453;
  return raw - Math.floor(raw);
}

function imageRatio(image: ShowImage) {
  if (image.width <= 0 || image.height <= 0) return 1;
  return image.height / image.width;
}

/** Width a card can sweep through with its rotation and sway. */
function floatCardFootprintWidth(
  width: number,
  height: number,
  rotation: number,
  drift: number
) {
  const maximumRotation = Math.abs(rotation) + floatRotationAmplitude;
  return (
    width * Math.abs(Math.cos(maximumRotation)) +
    height * Math.abs(Math.sin(maximumRotation)) +
    drift * 2 +
    12
  );
}

function rectanglesOverlap(left: FloatSlotBounds, right: FloatSlotBounds) {
  const overlapWidth = Math.max(
    0,
    Math.min(
      left.x + left.width / 2,
      right.x + right.width / 2
    ) -
      Math.max(
        left.x - left.width / 2,
        right.x - right.width / 2
      )
  );
  const overlapHeight = Math.max(
    0,
    Math.min(
      left.y + left.height / 2,
      right.y + right.height / 2
    ) -
      Math.max(
        left.y - left.height / 2,
        right.y - right.height / 2
      )
  );
  return overlapWidth * overlapHeight;
}

/**
 * Smallest center spacing to the neighbors, relative to each pair's mean size,
 * or -1 when the spot is too close to a neighbor or would cover too much of
 * either card.
 */
function floatSlotSpacing(
  slot: FloatSlotBounds,
  neighbors: readonly FloatSlotBounds[]
) {
  let spacing = Number.POSITIVE_INFINITY;
  const area = slot.width * slot.height;
  for (const neighbor of neighbors) {
    const distance = Math.hypot(
      (neighbor.x - slot.x) / ((neighbor.width + slot.width) / 2),
      (neighbor.y - slot.y) / ((neighbor.height + slot.height) / 2)
    );
    if (distance < floatMinimumSpacing) return -1;
    const overlap = rectanglesOverlap(slot, neighbor);
    if (overlap > floatMaximumOverlap * Math.min(area, neighbor.width * neighbor.height)) {
      return -1;
    }
    spacing = Math.min(spacing, distance);
  }
  return spacing;
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
  readonly #onNeedImages: (usage: ShowCandidateUsage) => void;
  readonly #onOpen: (image: ShowImage, key: string) => void;
  readonly #onVisibleItems: (items: readonly ShowPixiVisibleItem[]) => void;
  readonly #cards: FloatCardState[] = [];
  readonly #prefetchQueues: Record<FloatStreamDirection, FloatImagePlan[]> = {
    [-1]: [],
    [1]: []
  };
  readonly #handlePointerDown = (event: PointerEvent) => {
    if (!this.#inputEnabled) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (this.#dragPointerId !== null) {
      // A second touch point turns a touch drag into a pinch; further
      // pointers, and pointers of other types, are ignored. The runtime clears
      // a card's click intent only for non-primary pointers of the same type.
      if (
        event.pointerType === "touch" &&
        this.#dragPointerType === "touch" &&
        !this.#pinch
      ) this.#beginPinch(this.#dragPointerId, event);
      return;
    }
    this.#dragPointerId = event.pointerId;
    this.#dragPointerType = event.pointerType;
    this.#dragClientX = event.clientX;
    this.#dragClientY = event.clientY;
    this.#dragLastY = this.#eventY(event.clientY);
    this.#dragLastAt = event.timeStamp;
    this.#dragVelocityY = 0;
    this.#wheelScrollRemainingY = 0;
    this.#dragging = true;
    try {
      this.#inputElement.setPointerCapture(event.pointerId);
    } catch {
      // A detached canvas or an inactive pointer rejects capture.
    }
    if (event.cancelable) event.preventDefault();
  };
  readonly #handlePointerMove = (event: PointerEvent) => {
    if (!this.#inputEnabled) return;
    const pinchPoint = this.#pinch?.points.get(event.pointerId);
    if (pinchPoint) {
      pinchPoint.x = event.clientX;
      pinchPoint.y = event.clientY;
      this.#updatePinch(this.#pinch!, event.timeStamp);
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (event.pointerId !== this.#dragPointerId) return;
    this.#dragClientX = event.clientX;
    this.#dragClientY = event.clientY;
    if (!this.#dragging) return;
    const nextY = this.#eventY(event.clientY);
    const elapsed = Math.min(64, Math.max(1, event.timeStamp - this.#dragLastAt));
    const requestedDelta = nextY - this.#dragLastY;
    const appliedDelta = this.#applyVerticalDrag(requestedDelta, this.#dragPointerType);
    const sampledVelocity = appliedDelta / elapsed;
    if (sampledVelocity * this.#dragVelocityY < 0) this.#dragVelocityY = 0;
    const blend = Math.min(0.72, elapsed / 32);
    this.#dragVelocityY += (sampledVelocity - this.#dragVelocityY) * blend;
    if (Math.abs(appliedDelta - requestedDelta) > 0.01) {
      this.#dragVelocityY = 0;
    }
    this.#dragLastY = nextY;
    this.#dragLastAt = event.timeStamp;
    if (event.cancelable) event.preventDefault();
  };
  readonly #handlePointerUp = (event: PointerEvent) => {
    const pinch = this.#pinch;
    if (pinch?.points.has(event.pointerId)) {
      this.#releasePointer(event.pointerId);
      pinch.points.delete(event.pointerId);
      // The finger left on the screen stays inert until it lifts, so the end
      // of a pinch never turns into a drag.
      const [remaining] = pinch.points;
      this.#dragPointerId = remaining?.[0] ?? null;
      if (remaining) {
        this.#dragClientX = remaining[1].x;
        this.#dragClientY = remaining[1].y;
      }
      this.#pinch = null;
      this.#dragging = false;
      this.#dragVelocityY = 0;
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (event.pointerId !== this.#dragPointerId) return;
    this.#releasePointer(event.pointerId);
    this.#dragPointerId = null;
    this.#dragging = false;
    if (this.#reducedMotion) this.#dragVelocityY = 0;
    if (event.cancelable) event.preventDefault();
  };
  readonly #handleWheel = (event: WheelEvent) => {
    if (!this.#inputEnabled) return;
    const normalizedDelta =
      event.deltaY * (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? this.#height
            : 1);
    if (!Number.isFinite(normalizedDelta) || normalizedDelta === 0) return;
    this.#dragVelocityY = 0;
    if (event.ctrlKey) {
      this.#wheelScrollRemainingY = 0;
      this.#wheelSizeAccumulator = Math.max(
        -240,
        Math.min(
          240,
          this.#wheelSizeAccumulator + normalizedDelta
        )
      );
      if (
        Math.abs(this.#wheelSizeAccumulator) >= 48 &&
        event.timeStamp - this.#lastWheelSizeAt >= floatSizeStepIntervalMs
      ) {
        const direction = this.#wheelSizeAccumulator < 0 ? 1 : -1;
        const requested = clampShowFloatSizeIndex(this.#sizeIndex + direction);
        const next = clampShowFloatSizeIndex(this.#onSizeIndexChange(requested));
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
      this.#wheelScrollRemainingY = Math.max(
        -maximumPending,
        Math.min(
          maximumPending,
          this.#wheelScrollRemainingY + nextDelta
        )
      );
    }
    if (event.cancelable) event.preventDefault();
  };
  #images: ShowImage[] = [];
  readonly #consumedIds = new Set<string>();
  #hasMore = false;
  #lastUsageSignature = "";
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
  #lifecycleElapsed = 0;
  #nextSpawnAt = 0;
  /** Cards owed at the incoming end for the distance the stream has moved. */
  #entryQuota = 0;
  #waitingForImages = false;
  /** Viewport the band was last fully seated for. */
  #seatedWidth: number;
  #seatedHeight: number;
  /** Cards that left this frame, reused by the cards entering it. */
  readonly #spareCards: ShowPixiCard[] = [];
  #nextVisibleAt = 0;
  #lastVisibleSignature: string | null = null;
  #recycledSprites = 0;
  #rejectedSprites = 0;
  #layoutRevision = 0;
  #inputEnabled = true;
  #dragPointerId: number | null = null;
  #dragPointerType = "";
  #dragClientX = 0;
  #dragClientY = 0;
  #pinch: FloatPinch | null = null;
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
    this.#seatedWidth = this.#width;
    this.#seatedHeight = this.#height;
    this.#sizeIndex = clampShowFloatSizeIndex(options.sizeIndex);
    this.#speed = options.speed;
    this.#running = options.running;
    this.#reducedMotion = options.reducedMotion;
    this.root.sortableChildren = true;
    this.root.eventMode = "passive";
    this.setImages(options.images, options.dataKey, options.order, options.hasMore);
    this.#addInputListeners();
  }

  setSizeIndex(index: number) {
    const next = clampShowFloatSizeIndex(index);
    if (next === this.#sizeIndex) return;
    this.#sizeIndex = next;
    this.#reflow();
  }

  setSpeed(speed: number) {
    this.#speed = Math.max(0, Number.isFinite(speed) ? speed : 0);
  }

  resize(width: number, height: number) {
    const previousWidth = this.#width;
    const previousHeight = this.#height;
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);
    if (
      Math.abs(this.#width - previousWidth) < 1 &&
      Math.abs(this.#height - previousHeight) < 1
    ) return;
    const scaleX = this.#width / previousWidth;
    const scaleY = this.#height / previousHeight;
    for (const state of this.#cards) {
      state.x *= scaleX;
      state.y *= scaleY;
      state.offsetX *= scaleX;
      state.offsetY *= scaleY;
      if (state.heldY !== null) state.heldY *= scaleY;
    }
    // Small changes only nudge the cards. Once the viewport has moved well
    // away from the one the band was seated for, as a rotation or a long
    // window drag does, the band is re-seated. Height alone gets more room,
    // since a mobile toolbar showing or hiding changes it by about a tenth.
    const widthMoved = Math.abs(this.#width / this.#seatedWidth - 1) > 0.1;
    const heightMoved = Math.abs(this.#height / this.#seatedHeight - 1) > 0.25;
    if (widthMoved || heightMoved) this.#reflow();
    else this.#relayout();
  }

  setImages(images: readonly ShowImage[], dataKey: string, order: ShowOrder, hasMore: boolean) {
    this.#lastVisibleSignature = null;
    const replacing = dataKey !== this.#dataKey || order !== this.#order;
    const incoming = new Map(images.map((image) => [image.id, image]));
    // Candidate order is already committed by the network owner. Preserve
    // resident identities while making room for its next unconsumed entries.
    const retained = !replacing
      ? this.#images.flatMap((image) => {
          const updated = incoming.get(image.id);
          incoming.delete(image.id);
          return updated ? [updated] : [];
        })
      : [];
    const additions = [...incoming.values()];
    const nextImages = [
      ...retained,
      ...additions
    ].slice(0, 500);
    this.#dataKey = dataKey;
    this.#order = order;
    const previousCursor = this.#imageCursor;
    this.#images = nextImages;
    this.#hasMore = hasMore || images.length > nextImages.length;
    this.#lastUsageSignature = "";
    const nextIds = new Set(nextImages.map((image) => image.id));
    for (const id of this.#consumedIds) {
      if (replacing || !nextIds.has(id)) this.#consumedIds.delete(id);
    }
    this.#imageCursor = replacing || !nextImages.length
      ? 0
      : previousCursor % nextImages.length;
    let vacated = false;
    if (replacing) {
      this.#cancelVerticalInput();
      this.#clearTexturePrefetches();
      this.#removeAllCards();
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
      if (!imageMap.size) this.#removeAllCards();
      for (const state of this.#cards) {
        const currentId = state.card.image?.id;
        const nextImage = currentId ? imageMap.get(currentId) : undefined;
        if (!nextImage) {
          // The fading card's place is filled again right away.
          if (!state.retiring) vacated = true;
          this.#retire(state);
          continue;
        }
        this.#retargetCard(state, nextImage);
        this.#applyCardTransform(state);
      }
    }
    // A band that ran out of candidates is completed once more arrive.
    const incomplete = this.#waitingForImages;
    this.#waitingForImages = false;
    if (!this.#cards.length) {
      this.#seatedWidth = this.#width;
      this.#seatedHeight = this.#height;
      this.#fillStream(1);
      this.#publishVisibleItems();
    } else if (vacated || incomplete) {
      this.#fillStream(0);
    }
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
      this.#inputEnabled &&
      !this.#dragging &&
      Math.abs(this.#wheelScrollRemainingY) >= wheelScrollStopDistance
    ) {
      const progress = 1 - Math.exp(-elapsed / wheelScrollResponseMs);
      const requestedDelta = this.#wheelScrollRemainingY * progress;
      const appliedDelta = this.#applyVerticalDrag(requestedDelta);
      this.#wheelScrollRemainingY -= appliedDelta;
      if (
        Math.abs(appliedDelta - requestedDelta) > 0.01 ||
        Math.abs(this.#wheelScrollRemainingY) < wheelScrollStopDistance
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
      this.#inputEnabled &&
      !this.#dragging &&
      !this.#reducedMotion &&
      Math.abs(this.#dragVelocityY) >= minimumDragVelocity
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
    const moving = this.#running && !this.#reducedMotion && !manualMovement && !this.#pinch;
    if (moving) this.#setStreamDirection(-1);
    this.#lifecycleElapsed += elapsed;
    // The whole stream rises at one speed, so spacing settled at entry holds
    // for the entire journey; individual motion stays within the sway.
    const distance = moving ? (this.#speed * elapsed) / 1_000 : 0;
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
      // Hover/focus owns this card's motion lease: its slot moves on with the
      // stream while the card stays put. Releasing it eases the card back into
      // the slot, which no other card has taken in the meantime. Planar
      // rotation can still ease upright while the pointer owns the card.
      const held = state.card.isInteractionActive;
      if (held && state.heldY === null) state.heldY = this.#shownY(state);
      if (!held && state.heldY !== null) {
        state.offsetY = state.heldY - state.y;
        state.heldY = null;
      }
      if (distance) {
        state.y -= distance;
        if (!held) {
          state.phase += state.driftRate * elapsed;
          state.rotationPhase += state.rotationRate * elapsed;
        }
      }
      if (!held && !manualMovement) this.#settleOffset(state, elapsed);
      this.#straightenHoveredCard(state, elapsed);
      this.#applyCardTransform(state);
      state.card.update(elapsed, true);
      this.#updateVisibility(state);
    }
    if (distance) {
      this.#removeOutsideStream();
      this.#owe(distance);
    }
    if (this.#entryQuota >= 1 && this.#lifecycleElapsed >= this.#nextSpawnAt) {
      this.#nextSpawnAt = this.#lifecycleElapsed + floatSpawnIntervalMs;
      if (this.#replenish(this.#streamDirection)) this.#refreshTexturePrefetches();
    }
    this.#destroySpareCards();
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
      ? this.#cards.reduce((total, state) => total + state.card.root.y, 0) / this.#cards.length
      : 0;
    const horizontalBuckets = new Array<number>(8).fill(0);
    for (const state of visible) {
      const bucket = Math.min(
        7,
        Math.max(0, Math.floor(
          state.card.root.x / this.#width * horizontalBuckets.length
        ))
      );
      horizontalBuckets[bucket] += 1;
    }
    const horizontalConcentration = visibleSprites
      ? Math.max(...horizontalBuckets) / visibleSprites
      : 0;
    return {
      activeSprites: this.#cards.length,
      textureReadySprites: this.#cards.filter((state) => state.card.isTextureReady).length,
      visibleSprites,
      retainedDtos: this.#images.length,
      recycledSprites: this.#recycledSprites,
      rejectedSprites: this.#rejectedSprites,
      ...composition,
      horizontalConcentration,
      layoutRevision: this.#layoutRevision,
      inputEnabled: this.#inputEnabled,
      inputListenerCount: this.#inputListenerCount,
      activePointers: this.#pinch?.points.size ?? (this.#dragPointerId === null ? 0 : 1),
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
    this.#destroySpareCards();
    this.#images = [];
    this.#consumedIds.clear();
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
    this.#inputElement.addEventListener("lostpointercapture", this.#handlePointerUp, {
      passive: false
    });
    this.#inputElement.addEventListener("wheel", this.#handleWheel, {
      passive: false
    });
    this.#inputListenerCount = 6;
  }

  #applyVerticalDrag(requestedDelta: number, pointerType?: string) {
    if (!Number.isFinite(requestedDelta) || requestedDelta === 0) return 0;
    if (!this.#cards.length) return 0;
    this.#setStreamDirection(requestedDelta < 0 ? -1 : 1);
    // Advance the stream in bounded spatial steps. Even a large pointer delta
    // replenishes the incoming band before moving through it.
    const maximumStep = Math.max(32, Math.min(128, this.#streamBuffer() * 0.25));
    const steps = Math.ceil(Math.abs(requestedDelta) / maximumStep);
    const delta = requestedDelta / steps;
    let replenished = false;
    for (let step = 0; step < steps; step += 1) {
      for (const state of this.#cards) {
        state.y += delta;
        if (state.heldY !== null) state.heldY += delta;
      }
      this.#removeOutsideStream();
      this.#owe(Math.abs(delta));
      if (this.#replenish(this.#streamDirection)) replenished = true;
    }
    if (replenished) this.#refreshTexturePrefetches();
    this.#destroySpareCards();
    this.#onManualVerticalMovement(-requestedDelta, pointerType);
    return requestedDelta;
  }

  #beginPinch(firstPointerId: number, event: PointerEvent) {
    this.#pinch = {
      points: new Map([
        [firstPointerId, { x: this.#dragClientX, y: this.#dragClientY }],
        [event.pointerId, { x: event.clientX, y: event.clientY }]
      ]),
      distance: Math.max(
        1,
        Math.hypot(event.clientX - this.#dragClientX, event.clientY - this.#dragClientY)
      ),
      changedAt: Number.NEGATIVE_INFINITY
    };
    // A pinch only changes the size step; it never moves the stream.
    this.#dragging = false;
    this.#dragVelocityY = 0;
    this.#wheelScrollRemainingY = 0;
    try {
      this.#inputElement.setPointerCapture(event.pointerId);
    } catch {
      // A detached canvas or an inactive pointer rejects capture.
    }
    if (event.cancelable) event.preventDefault();
  }

  #updatePinch(pinch: FloatPinch, timeStamp: number) {
    const [first, second] = [...pinch.points.values()];
    if (!first || !second) return;
    const distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
    const ratio = distance / pinch.distance;
    if (
      Math.abs(Math.log(ratio)) < Math.log(floatPinchStepRatio) ||
      timeStamp - pinch.changedAt < floatSizeStepIntervalMs
    ) return;
    const requested = clampShowFloatSizeIndex(this.#sizeIndex + (ratio > 1 ? 1 : -1));
    this.setSizeIndex(clampShowFloatSizeIndex(this.#onSizeIndexChange(requested)));
    pinch.distance = distance;
    pinch.changedAt = timeStamp;
  }

  #hasManualMovement() {
    return (
      this.#inputEnabled &&
      (this.#dragging ||
        Math.abs(this.#wheelScrollRemainingY) >= wheelScrollStopDistance ||
        (!this.#reducedMotion && Math.abs(this.#dragVelocityY) >= minimumDragVelocity))
    );
  }

  #removeOutsideStream() {
    const top = -this.#streamBuffer();
    const bottom = this.#height + this.#streamBuffer();
    for (let index = this.#cards.length - 1; index >= 0; index -= 1) {
      const state = this.#cards[index];
      // A card held in view, or easing back to its slot, stays until both
      // the card and its slot have left the band.
      const half = Math.max(state.card.height, state.card.targetHeight) / 2;
      const outside = (y: number) => y + half < top || y - half > bottom;
      if (outside(state.y) && outside(this.#shownY(state))) this.#removeCard(index);
    }
  }

  #cancelVerticalInput() {
    for (const pointerId of this.#pinch?.points.keys() ?? []) this.#releasePointer(pointerId);
    this.#pinch = null;
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
      if (this.#inputElement.hasPointerCapture(pointerId)) {
        this.#inputElement.releasePointerCapture(pointerId);
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

  /**
   * Bring the band up to the stream density wherever it falls short, by
   * sweeping a floor down from its top exactly as the stream itself fills its
   * incoming end. Cards are counted once their far edge passes the floor.
   * Cards given to re-seat keep their order down the band: each takes the
   * next opening once the sweep reaches it, new cards fill in between when the
   * density needs more, and cards the sweep leaves behind fade out.
   */
  #fillStream(alpha: number, reseat: readonly FloatCardState[] = []) {
    const top = -this.#streamBuffer();
    const bottom = this.#height + this.#streamBuffer();
    const side = this.#cardSide();
    const travelPerCard = this.#travelPerCard();
    const pending = [...reseat];
    const waiting = new Set(pending);
    const placed = this.#cards
      .filter((state) => !state.retiring && !waiting.has(state))
      .map((state) => this.#slotOf(state));
    const shownBottom = (state: FloatCardState) =>
      this.#shownY(state) + state.card.targetHeight / 2;
    const step = travelPerCard / 4;
    for (let floor = top + step; floor < bottom + step; floor += step) {
      const edge = Math.min(floor, bottom);
      const target = Math.round((edge - top) / travelPerCard);
      while (pending.length && shownBottom(pending[0]!) < edge - side * 1.5) {
        this.#retire(pending.shift()!);
      }
      let count = placed.filter((bounds) => bounds.y + bounds.height / 2 <= edge).length;
      while (count < target) {
        const next = pending[0];
        const state = next && shownBottom(next) <= edge + side * 0.5
          ? this.#reseatCard(next, edge, top, placed)
          : this.#placeNext(-1, edge, top, alpha, placed);
        if (!state) break;
        if (state === next) pending.shift();
        placed.push(this.#slotOf(state));
        count += 1;
      }
    }
    for (const state of pending) this.#retire(state);
    this.#entryQuota = 0;
  }

  /**
   * Add the cards owed for the distance the stream has moved, at its
   * incoming end, so the band keeps the stream density. Because the stream
   * moves as one sheet, the spacing settled there is what later passes
   * through the viewport. Cards with no opening yet stay owed.
   */
  #replenish(direction: FloatStreamDirection) {
    const buffer = this.#streamBuffer();
    const floor = direction < 0 ? this.#height + buffer : -buffer;
    const nearLimit = direction < 0 ? this.#height : 0;
    const placed = this.#cards
      .filter((state) => !state.retiring)
      .map((state) => this.#slotOf(state));
    let added = 0;
    while (this.#entryQuota >= 1) {
      const state = this.#placeNext(direction, floor, nearLimit, 0, placed);
      if (!state) break;
      placed.push(this.#slotOf(state));
      this.#entryQuota -= 1;
      added += 1;
    }
    return added > 0;
  }

  /**
   * Owe cards for stream travel. Cards still waiting for an opening stay
   * owed, up to twice what the incoming band holds.
   */
  #owe(distance: number) {
    const travelPerCard = this.#travelPerCard();
    this.#entryQuota = Math.min(
      Math.max(3, (this.#streamBuffer() * 2) / travelPerCard),
      this.#entryQuota + distance / travelPerCard
    );
  }

  #setStreamDirection(direction: FloatStreamDirection) {
    if (direction === this.#streamDirection) return;
    // Cards owed at one end are not owed at the other.
    this.#streamDirection = direction;
    this.#entryQuota = 0;
  }

  /**
   * Stream travel per card at the stream density, from the mean area of the
   * candidates not yet consumed (or the whole pool once all are queued or
   * shown): cards a viewport limit makes smaller leave room for more.
   */
  #travelPerCard() {
    const upcoming = this.#images
      .filter((image) => !this.#consumedIds.has(image.id))
      .slice(0, 64);
    const sample = upcoming.length ? upcoming : this.#images.slice(0, 64);
    const meanArea = sample.length
      ? sample.reduce((total, image) => {
          const { width, height } = this.#cardSize(imageRatio(image), 1);
          return total + width * height;
        }, 0) / sample.length
      : this.#cardSide() ** 2;
    return meanArea / (showFloatPacking * this.#width);
  }

  /**
   * Place the next planned image of a direction near the floor, the end of
   * the band being filled. The plan stays queued, with its texture lease,
   * until a slot opens for it.
   */
  #placeNext(
    direction: FloatStreamDirection,
    floor: number,
    nearLimit: number,
    alpha: number,
    neighbors: readonly FloatSlotBounds[]
  ) {
    // The Sprite cap counts settled cards only. Cards fading out leave within
    // moments and must not hold back the cards that fill their openings, so
    // the total may briefly exceed the cap while the band is re-seated.
    const settled = this.#cards.filter((state) => !state.retiring).length;
    if (settled >= this.#maximumCards()) {
      if (this.#images.length) this.#rejectedSprites += 1;
      return null;
    }
    const queue = this.#prefetchQueues[direction];
    if (!queue.length) {
      const plan = this.#createImagePlan();
      if (!plan) {
        this.#waitingForImages = true;
        return null;
      }
      queue.push(plan);
    }
    const plan = queue[0]!;
    const geometry = this.#planGeometry(plan);
    const slot = this.#openSlot(geometry, floor, nearLimit, direction, neighbors);
    if (!slot) return null;
    queue.shift();
    return this.#addCard(plan, geometry, slot.x, slot.y, alpha);
  }

  /** Move a card to an opening near the floor, close to where it is shown. */
  #reseatCard(
    state: FloatCardState,
    floor: number,
    nearLimit: number,
    neighbors: readonly FloatSlotBounds[]
  ) {
    const image = state.card.image;
    if (!image) return null;
    const shownX = state.x + state.offsetX;
    const shownY = this.#shownY(state);
    const slot = this.#openSlot(
      this.#cardGeometry(state, image),
      floor,
      nearLimit,
      -1,
      neighbors,
      shownX
    );
    if (!slot) return null;
    state.x = slot.x;
    state.y = slot.y;
    state.offsetX = shownX - slot.x;
    state.offsetY = shownY - slot.y;
    return state;
  }

  /**
   * Choose the most open slot for a card with its far edge just inside the
   * floor and, when it fits, its near edge beyond the limit. The unfilled side
   * beyond the floor counts as occupied, so cards do not gather against it
   * and leave openings behind. A card being re-seated prefers openings near
   * its current column.
   */
  #openSlot(
    geometry: FloatCardGeometry,
    floor: number,
    nearLimit: number,
    direction: FloatStreamDirection,
    neighbors: readonly FloatSlotBounds[],
    nearX?: number
  ) {
    const { minimumX, maximumX } = this.#horizontalRange(geometry);
    const side = Math.sqrt(geometry.width * geometry.height);
    const half = geometry.height / 2;
    // How far the far edge may sit from the floor. A card taller than the
    // room before the limit is placed right at the floor.
    const room = Math.abs(floor - nearLimit) - geometry.height;
    const depth = Math.max(0, Math.min(this.#cardSide() * floatPlacementDepth, room));
    const reach = side * 3 + depth;
    const nearby = neighbors.filter((bounds) => Math.abs(bounds.y - floor) < reach + half);
    let best: { x: number; y: number; score: number } | null = null;
    for (let attempt = 0; attempt < floatPlacementCandidates; attempt += 1) {
      const local = nearX !== undefined && attempt % 2 === 0;
      const x = local
        ? Math.max(minimumX, Math.min(maximumX, nearX + (Math.random() - 0.5) * 1.2 * side))
        : minimumX + Math.random() * (maximumX - minimumX);
      const y = floor + direction * (half + Math.random() * depth);
      const spacing = floatSlotSpacing(
        { x, y, width: geometry.width, height: geometry.height },
        nearby
      );
      if (spacing < 0) continue;
      const shift = nearX === undefined ? 0 : Math.abs(x - nearX) / side;
      const score = Math.min(spacing, Math.abs(floor - y) / side + 0.5) - shift * 0.15;
      if (!best || score > best.score) best = { x, y, score };
    }
    return best;
  }

  /**
   * Re-seat the band after the card size or the viewport changed markedly:
   * cards keep their order down the band and move to nearby openings at the
   * current size. Held cards stay where they are shown.
   */
  #reflow() {
    const reseat: FloatCardState[] = [];
    for (const state of this.#cards) {
      if (state.retiring) continue;
      this.#retargetCard(state);
      if (!state.card.isInteractionActive) {
        reseat.push(state);
        continue;
      }
      state.x += state.offsetX;
      state.y = this.#shownY(state);
      state.offsetX = 0;
      state.offsetY = 0;
    }
    reseat.sort((left, right) => this.#shownY(left) - this.#shownY(right));
    this.#seatedWidth = this.#width;
    this.#seatedHeight = this.#height;
    this.#fillStream(0, reseat);
    this.#refreshTexturePrefetches();
    this.#layoutRevision += 1;
  }

  /**
   * Adjust the band after a small viewport change. Each card keeps its
   * displayed position and eases into the nearest slot that keeps the spacing
   * rules; cards without one fade out, and openings are refilled.
   */
  #relayout() {
    const top = -this.#streamBuffer();
    const bottom = this.#height + this.#streamBuffer();
    const centerY = this.#height / 2;
    const placed: FloatSlotBounds[] = [];
    // Held cards stay where they are shown; the rest are re-seated outward
    // from the middle of the viewport, so any cards that no longer fit are
    // the ones farthest from view.
    const ordered = this.#cards
      .filter((state) => !state.retiring)
      .sort((left, right) =>
        Number(right.card.isInteractionActive) - Number(left.card.isInteractionActive)
        || Math.abs(this.#shownY(left) - centerY) - Math.abs(this.#shownY(right) - centerY));
    for (const state of ordered) {
      const shownX = state.x + state.offsetX;
      const shownY = this.#shownY(state);
      const geometry = this.#retargetCard(state);
      if (!geometry) continue;
      const slot = state.card.isInteractionActive
        ? { x: shownX, y: shownY }
        : this.#nearestSlot(geometry, { x: state.x, y: state.y }, placed, top, bottom);
      if (!slot) {
        this.#retire(state);
        continue;
      }
      state.x = slot.x;
      state.y = slot.y;
      state.offsetX = shownX - slot.x;
      state.offsetY = shownY - slot.y;
      placed.push(this.#slotOf(state));
    }
    this.#fillStream(0);
    this.#refreshTexturePrefetches();
    this.#layoutRevision += 1;
  }

  #nearestSlot(
    geometry: FloatCardGeometry,
    proposal: { x: number; y: number },
    placed: readonly FloatSlotBounds[],
    top: number,
    bottom: number
  ) {
    const { minimumX, maximumX } = this.#horizontalRange(geometry);
    // Any slot still overlapping the band, the bounds cards are removed by.
    const minimumY = top - geometry.height / 2 + 1;
    const maximumY = bottom + geometry.height / 2 - 1;
    const side = Math.sqrt(geometry.width * geometry.height);
    // Search rings around the proposal, nearest first.
    for (let ring = 0; ring <= 6; ring += 1) {
      const radius = ring * side * 0.15;
      const points = ring ? ring * 8 : 1;
      for (let point = 0; point < points; point += 1) {
        const angle = ((point + ring * goldenRatioConjugate) / points) * Math.PI * 2;
        const x = Math.max(minimumX, Math.min(maximumX, proposal.x + Math.cos(angle) * radius));
        const y = proposal.y + Math.sin(angle) * radius;
        if (y < minimumY || y > maximumY) continue;
        const bounds = { x, y, width: geometry.width, height: geometry.height };
        if (floatSlotSpacing(bounds, placed) >= 0) return { x, y };
      }
    }
    return null;
  }

  /**
   * Card centers keep the rotated, swaying card within the side edges, less
   * the share of its width it may reach past them.
   */
  #horizontalRange(geometry: FloatCardGeometry) {
    const footprintWidth = floatCardFootprintWidth(
      geometry.width,
      geometry.height,
      geometry.rotation,
      geometry.drift
    );
    const margin = footprintWidth / 2 + 8 - geometry.width * floatSideOverhang;
    const minimumX = Math.min(this.#width / 2, margin);
    return {
      minimumX,
      maximumX: Math.max(minimumX, this.#width - margin)
    };
  }

  #slotOf(state: FloatCardState): FloatSlotBounds {
    return {
      x: state.x,
      y: state.y,
      width: state.card.targetWidth,
      height: state.card.targetHeight
    };
  }

  /** Apply the current card size, and any updated image, to a card. */
  #retargetCard(state: FloatCardState, image = state.card.image) {
    if (!image) return null;
    const geometry = this.#cardGeometry(state, image);
    state.drift = geometry.drift;
    state.card.assign(
      state.card.key,
      image,
      geometry.width,
      geometry.height,
      state.card.baseRotation,
      true,
      geometry.width
    );
    return geometry;
  }

  #addCard(
    plan: FloatImagePlan,
    geometry: FloatCardGeometry,
    x: number,
    y: number,
    alpha: number
  ) {
    const { image, serial, sizeFactor } = plan;
    // A card that left this frame takes the new image; a new key resets its
    // focus, hover and depth.
    const card = this.#spareCards.pop() ?? new ShowPixiCard(
      this.#textureCache,
      this.#onOpen,
      this.#renderer,
      this.#perspectiveCoordinator
    );
    card.setInteractionEnabled(this.#inputEnabled);
    const state: FloatCardState = {
      card,
      x,
      y,
      offsetX: 0,
      offsetY: 0,
      heldY: null,
      drift: geometry.drift,
      driftFactor: this.#driftFactor(serial),
      driftRate: 0.0001 + noise(serial, 6) * 0.00008,
      phase: noise(serial, 4) * Math.PI * 2,
      rotationPhase: noise(serial, 12) * Math.PI * 2,
      rotationRate: (Math.PI * 2) / (24_000 + noise(serial, 13) * 16_000),
      hoverRotationFrom: null,
      hoverRotationElapsed: 0,
      sizeFactor,
      retiring: false
    };
    card.assign(
      `float:${serial}`,
      image,
      geometry.width,
      geometry.height,
      geometry.rotation,
      false,
      geometry.width
    );
    // The card acquires the same image/size lease before prefetch releases it.
    this.#releaseImagePlan(plan);
    card.root.alpha = alpha;
    // A stable random depth lets overlapping neighbors alternate which one is
    // on top, as cards at different depths do in the cluster.
    const depth = Math.floor(noise(serial, 17) * (this.root.children.length + 1));
    this.root.addChildAt(card.root, depth);
    this.#cards.push(state);
    this.#applyCardTransform(state);
    this.#updateVisibility(state);
    this.#layoutRevision += 1;
    return state;
  }

  #updateVisibility(state: FloatCardState) {
    const y = state.card.root.y;
    const buffer = Math.max(72, state.card.height * 0.35);
    state.card.setVisible(
      y + state.card.height / 2 >= -buffer &&
      y - state.card.height / 2 <= this.#height + buffer
    );
  }

  #retire(state: FloatCardState) {
    state.retiring = true;
    state.card.setInteractionEnabled(false);
  }

  #driftFactor(serial: number) {
    return 0.025 + noise(serial, 5) * 0.045;
  }

  #planGeometry(plan: FloatImagePlan): FloatCardGeometry {
    const { width, height } = this.#cardSize(imageRatio(plan.image), plan.sizeFactor);
    return {
      width,
      height,
      rotation: (noise(plan.serial, 11) - 0.5) * 0.17,
      drift: Math.min(16, width * this.#driftFactor(plan.serial))
    };
  }

  #cardGeometry(state: FloatCardState, image: ShowImage): FloatCardGeometry {
    const { width, height } = this.#cardSize(imageRatio(image), state.sizeFactor);
    return {
      width,
      height,
      rotation: state.card.baseRotation,
      drift: Math.min(16, width * state.driftFactor)
    };
  }

  #settleOffset(state: FloatCardState, elapsed: number) {
    if (!state.offsetX && !state.offsetY) return;
    if (this.#reducedMotion) {
      state.offsetX = 0;
      state.offsetY = 0;
      return;
    }
    const progress = 1 - Math.exp(-elapsed / floatSettleMs);
    let stepX = state.offsetX * progress;
    let stepY = state.offsetY * progress;
    // A long hover leaves the slot far away; return at a bounded speed.
    const length = Math.hypot(stepX, stepY);
    const limit = (floatSettleSpeed * elapsed) / 1_000;
    if (length > limit) {
      stepX *= limit / length;
      stepY *= limit / length;
    }
    state.offsetX -= stepX;
    state.offsetY -= stepY;
    if (Math.abs(state.offsetX) < 0.1) state.offsetX = 0;
    if (Math.abs(state.offsetY) < 0.1) state.offsetY = 0;
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
    state.hoverRotationElapsed = Math.min(
      floatHoverStraightenMs,
      state.hoverRotationElapsed + elapsed
    );
    const progress = this.#reducedMotion ? 1 : state.hoverRotationElapsed / floatHoverStraightenMs;
    const angle = state.hoverRotationFrom * (1 - progress) ** 3;
    // Rebase the existing oscillator instead of returning to the old static
    // tilt on release. Even an interrupted straighten resumes at its current
    // angle, preserving the rotation phase, speed and three-degree amplitude.
    state.card.baseRotation = angle - swing;
  }

  #shownY(state: FloatCardState) {
    return state.heldY ?? state.y + state.offsetY;
  }

  #applyCardTransform(state: FloatCardState) {
    state.card.root.position.set(
      state.x + state.offsetX + Math.sin(state.phase) * state.drift,
      this.#shownY(state)
    );
    state.card.root.rotation =
      state.card.baseRotation +
      (this.#reducedMotion ? 0 : Math.sin(state.rotationPhase) * floatRotationAmplitude);
  }

  #cardSize(ratio: number, factor: number) {
    // Equal-area cards, as in the cluster, limited so the rotated card keeps
    // room for viewing within the viewport.
    const side = this.#cardSide() * factor;
    const angle = 0.085 + floatRotationAmplitude;
    const widthLimit = Math.max(24, this.#width - 56) / (Math.cos(angle) + ratio * Math.sin(angle));
    const heightLimit =
      Math.max(24, this.#height - showFloatViewingMargin) /
      (ratio * Math.cos(angle) + Math.sin(angle));
    const width = Math.min(side / Math.sqrt(ratio), widthLimit, heightLimit);
    return { width, height: width * ratio };
  }

  #cardSide() {
    // Small size steps stop where the band, two screens tall at such sizes,
    // would outgrow the Sprite cap.
    const minimum = Math.sqrt(
      (showFloatPacking * this.#width * this.#height * 2) / (this.#maximumCards() * 0.9)
    );
    return Math.max(
      showFloatStepSide(this.#sizeIndex, this.#width, this.#height),
      minimum
    );
  }

  #expectedCount() {
    return Math.min(
      this.#maximumCards(),
      Math.round(this.#streamHeight() / this.#travelPerCard())
    );
  }

  #maximumCards() {
    return Math.floor(Math.min(180, 96 + Math.max(0, this.#width - 760) * 0.15));
  }

  #streamBuffer() {
    // Half a screen, and at least a 2:1 portrait card at the current size, so
    // such cards enter hidden apart from a rotated corner; longer images fade
    // in at the edge.
    return Math.max(this.#height * 0.5, this.#cardSize(2, 1 + floatSizeSpread).height + 16);
  }

  #streamHeight() {
    // The visible viewport plus the retained bands above and below it, which
    // keep both scroll directions populated and texture-ready.
    return this.#height + this.#streamBuffer() * 2;
  }

  #destroySpareCards() {
    for (const card of this.#spareCards) card.destroy();
    this.#spareCards.length = 0;
  }

  #removeAllCards() {
    for (const state of this.#cards) {
      state.card.root.parent?.removeChild(state.card.root);
      state.card.destroy();
    }
    this.#cards.length = 0;
  }

  #removeCard(index: number) {
    const state = this.#cards[index];
    if (!state) return;
    state.card.root.parent?.removeChild(state.card.root);
    this.#spareCards.push(state.card);
    this.#cards.splice(index, 1);
    this.#recycledSprites += 1;
    this.#layoutRevision += 1;
  }

  #createImagePlan(): FloatImagePlan | null {
    if (!this.#images.length) return null;
    let image = this.#images.find((candidate) => !this.#consumedIds.has(candidate.id));
    if (!image) {
      if (this.#hasMore) return null;
      if (this.#imageCursor === 0 && this.#order === "random") {
        this.#images = shuffledImageBatch(this.#images);
      }
      const active = this.#referencedImageIds();
      let index = this.#imageCursor % this.#images.length;
      for (let offset = 0; offset < this.#images.length; offset += 1) {
        const candidate = (index + offset) % this.#images.length;
        if (!active.has(this.#images[candidate]!.id)) {
          index = candidate;
          break;
        }
      }
      image = this.#images[index]!;
      this.#imageCursor = (index + 1) % this.#images.length;
    }
    this.#consumedIds.add(image.id);
    const serial = this.#serial++;
    return {
      image,
      serial,
      sizeFactor: floatSizeFactor(serial),
      textureKey: "",
      lease: null
    };
  }

  #refreshTexturePrefetches() {
    const count = this.#images.length
      ? Math.min(
          this.#width <= 760 ? 18 : 36,
          Math.max(
            this.#width <= 760 ? 6 : 12,
            Math.ceil(this.#expectedCount() / 3)
          )
        )
      : 0;
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
        const { image, sizeFactor } = plan;
        const ratio = imageRatio(image);
        const { width } = this.#cardSize(ratio, sizeFactor);
        const lod = showPixiTextureLod(image, width, ratio);
        const textureKey = `${image.id}:${imageVariantUrl(image, "small")}:${lod.pixelWidth}x${lod.pixelHeight}`;
        if (plan.textureKey === textureKey && plan.lease) continue;
        this.#releaseImagePlan(plan);
        pending.push({ plan, textureKey, lod });
      }
    }
    // Release obsolete LODs at both ends before acquiring their replacements.
    for (const { plan, textureKey, lod } of pending) {
      plan.textureKey = textureKey;
      plan.lease = this.#textureCache.acquire(imageVariantUrl(plan.image, "small"), lod, () => undefined);
    }
    this.#requestCandidates();
  }

  #requestCandidates() {
    const available = this.#images.filter((image) => !this.#consumedIds.has(image.id)).length;
    if (available >= 100) return;
    const active = this.#referencedImageIds();
    const signature = `${this.#dataKey}:${this.#consumedIds.size}:${available}:${[...active].join(",")}`;
    if (signature === this.#lastUsageSignature) return;
    this.#lastUsageSignature = signature;
    this.#onNeedImages({
      dataKey: this.#dataKey,
      activeIds: [...active],
      consumedIds: [...this.#consumedIds],
      available,
      capacity: 500
    });
  }

  #referencedImageIds() {
    const active = new Set(
      this.#cards.flatMap((state) => (state.card.image ? [state.card.image.id] : []))
    );
    for (const queue of Object.values(this.#prefetchQueues)) {
      for (const plan of queue) active.add(plan.image.id);
    }
    return active;
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

  #publishVisibleItems() {
    // Fading cards are leaving and no longer accept input.
    const items = this.#cards
      .filter((state) => state.card.visible && !state.retiring && state.card.image)
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
      const clippedWidth = Math.max(
        0,
        Math.min(
          this.#width,
          left.card.root.x + width / 2
        ) -
          Math.max(0, left.card.root.x - width / 2)
      );
      const clippedHeight = Math.max(
        0,
        Math.min(
          this.#height,
          left.card.root.y + height / 2
        ) - Math.max(0, left.card.root.y - height / 2)
      );
      totalArea += clippedWidth * clippedHeight;
      for (let other = index + 1; other < visible.length; other += 1) {
        const right = visible[other];
        overlapArea += rectanglesOverlap(
          {
            x: left.card.root.x,
            y: left.card.root.y,
            width,
            height
          },
          {
            x: right.card.root.x,
            y: right.card.root.y,
            width: right.card.width,
            height: right.card.height
          }
        );
      }
    }
    return {
      coverageRatio: Math.min(1, totalArea / Math.max(1, this.#width * this.#height)),
      overlapRatio: Math.min(1, overlapArea / Math.max(1, totalArea))
    };
  }
}
