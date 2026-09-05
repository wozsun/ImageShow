import { Container } from "pixi.js";

export type ShowPixiCameraPoint = {
  x: number;
  y: number;
};

export type ShowPixiCameraBounds = ShowPixiCameraPoint & {
  width: number;
  height: number;
};

type PointerSample = {
  point: ShowPixiCameraPoint;
  timestamp: number;
};

type PinchState = {
  distance: number;
  scale: number;
  worldAnchor: ShowPixiCameraPoint;
};

export type ShowPixiCameraOptions = {
  element: HTMLElement;
  width: number;
  height: number;
  initialScale: number;
  minimumScale: number;
  maximumScale: number;
  friction?: number;
  minimumVelocity?: number;
  wheelZoomRate?: number;
  onManualVerticalMovement?: (delta: number, pointerType?: string) => void;
  onZoomRequest?: (scale: number) => number;
  onZoomEnd?: (scale: number) => void;
};

const clamp = (value: number, minimum: number, maximum: number) => (
  Math.min(maximum, Math.max(minimum, value))
);

const distance = (left: ShowPixiCameraPoint, right: ShowPixiCameraPoint) => (
  Math.hypot(left.x - right.x, left.y - right.y)
);

const midpoint = (left: ShowPixiCameraPoint, right: ShowPixiCameraPoint) => ({
  x: (left.x + right.x) / 2,
  y: (left.y + right.y) / 2
});

const wheelPanResponseMs = 86;
const wheelPanStopDistance = 0.08;

/**
 * ImageShow-owned camera controller for the waterfall scene.
 *
 * Its behavior was compared with pixi-viewport 6.0.3 (tag `6.0.3`, commit
 * 19265f8f03d71954a71de17505671db66e23ef1e), but no upstream source is
 * copied here. The controller deliberately exposes only the transforms and
 * input lifecycle used by Show, so it can evolve with the local Pixi runtime
 * without retaining pixi-viewport's general plugin framework.
 */
export class ShowPixiCamera {
  readonly root = new Container();
  readonly #element: HTMLElement;
  readonly #onManualVerticalMovement: (delta: number, pointerType?: string) => void;
  readonly #onZoomRequest: (scale: number) => number;
  readonly #onZoomEnd: (scale: number) => void;
  readonly #pointers = new Map<number, PointerSample>();
  readonly #friction: number;
  readonly #minimumVelocity: number;
  readonly #wheelZoomRate: number;
  readonly #handlePointerDown = (event: PointerEvent) => {
    if (!this.#inputEnabled) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = this.#eventPoint(event.clientX, event.clientY);
    this.#pointers.set(event.pointerId, {
      point,
      timestamp: event.timeStamp
    });
    this.#velocityX = 0;
    this.#velocityY = 0;
    this.#wheelPanRemainingY = 0;
    this.#wheelIdleMs = 0;
    try {
      this.#element.setPointerCapture?.(event.pointerId);
    } catch {
      // A detached canvas or a synthetic test event may reject capture.
    }
    if (this.#pointers.size >= 2) this.#beginPinch();
    else this.#dragging = true;
    if (event.cancelable) event.preventDefault();
  };
  readonly #handlePointerMove = (event: PointerEvent) => {
    if (!this.#inputEnabled) return;
    const previous = this.#pointers.get(event.pointerId);
    if (!previous) return;
    const point = this.#eventPoint(event.clientX, event.clientY);
    this.#pointers.set(event.pointerId, {
      point,
      timestamp: event.timeStamp
    });
    if (this.#pointers.size >= 2) {
      if (!this.#pinch) this.#beginPinch();
      const pair = this.#pointerPair();
      if (pair && this.#pinch) {
        const nextMidpoint = midpoint(pair[0].point, pair[1].point);
        const nextDistance = Math.max(1, distance(pair[0].point, pair[1].point));
        const nextScale = this.#pinch.scale
          * nextDistance / this.#pinch.distance;
        this.#setScaleAtWorldAnchor(
          this.#onZoomRequest(this.#clampScale(nextScale)),
          nextMidpoint,
          this.#pinch.worldAnchor
        );
      }
    } else {
      const elapsed = clamp(event.timeStamp - previous.timestamp, 1, 64);
      const deltaX = point.x - previous.point.x;
      const deltaY = point.y - previous.point.y;
      this.#dragPointerType = event.pointerType;
      this.#panFromInput(deltaX, deltaY, this.#dragPointerType);
      const blend = Math.min(0.72, elapsed / 32);
      this.#velocityX += (deltaX / elapsed - this.#velocityX) * blend;
      this.#velocityY += (deltaY / elapsed - this.#velocityY) * blend;
    }
    if (event.cancelable) event.preventDefault();
  };
  readonly #handlePointerUp = (event: PointerEvent) => {
    if (!this.#pointers.has(event.pointerId)) return;
    const wasPinching = this.#pinch !== null;
    this.#pointers.delete(event.pointerId);
    try {
      if (this.#element.hasPointerCapture?.(event.pointerId)) {
        this.#element.releasePointerCapture?.(event.pointerId);
      }
    } catch {
      // Pointer capture may already have been released by the browser.
    }
    if (this.#pointers.size >= 2) {
      this.#beginPinch();
    } else {
      if (wasPinching) {
        this.#pinch = null;
        this.#velocityX = 0;
        this.#velocityY = 0;
        this.#onZoomEnd(this.scale);
      }
      this.#dragging = this.#pointers.size === 1;
      const remaining = this.#pointers.values().next().value as PointerSample | undefined;
      if (remaining) remaining.timestamp = event.timeStamp;
    }
    if (!this.#pointers.size) this.#dragging = false;
    if (event.cancelable) event.preventDefault();
  };
  readonly #handleWheel = (event: WheelEvent) => {
    if (!this.#inputEnabled) return;
    const lineHeight = 16;
    const normalizedDelta = event.deltaY * (
      event.deltaMode === 1
        ? lineHeight
        : event.deltaMode === 2
          ? this.#height
          : 1
    );
    if (!Number.isFinite(normalizedDelta) || normalizedDelta === 0) return;
    this.#velocityX = 0;
    this.#velocityY = 0;
    if (event.ctrlKey) {
      this.#wheelPanRemainingY = 0;
      const anchor = this.#eventPoint(event.clientX, event.clientY);
      const nextScale = this.scale * Math.exp(
        -clamp(normalizedDelta, -720, 720) * this.#wheelZoomRate
      );
      this.setZoom(this.#onZoomRequest(this.#clampScale(nextScale)), anchor);
      this.#wheelIdleMs = 140;
    } else {
      // A plain wheel follows document scrolling semantics: wheel down moves
      // the world upward. Horizontal wheel/trackpad deltas are intentionally
      // ignored; camera zoom is reserved for Ctrl + wheel and pinch. Accumulate
      // wheel ticks and consume them from the shared ticker so a mechanical
      // wheel does not move the world in visible coordinate jumps.
      const maximumPending = Math.max(720, this.#height * 1.5);
      this.#wheelPanRemainingY = clamp(
        this.#wheelPanRemainingY - clamp(normalizedDelta, -720, 720),
        -maximumPending,
        maximumPending
      );
      this.#wheelIdleMs = 0;
    }
    if (event.cancelable) event.preventDefault();
  };
  readonly #handleContextMenu = (event: MouseEvent) => {
    if (this.#inputEnabled && event.cancelable) event.preventDefault();
  };
  #width: number;
  #height: number;
  #minimumScale: number;
  #maximumScale: number;
  #inputEnabled = true;
  #dragging = false;
  #dragPointerType = "";
  #pinch: PinchState | null = null;
  #velocityX = 0;
  #velocityY = 0;
  #wheelPanRemainingY = 0;
  #wheelIdleMs = 0;
  #listenerCount = 0;
  #destroyed = false;

  constructor(options: ShowPixiCameraOptions) {
    this.#element = options.element;
    this.#width = Math.max(1, options.width);
    this.#height = Math.max(1, options.height);
    this.#minimumScale = Math.max(0.0001, options.minimumScale);
    this.#maximumScale = Math.max(this.#minimumScale, options.maximumScale);
    this.#friction = clamp(options.friction ?? 0.92, 0, 0.9999);
    this.#minimumVelocity = Math.max(0.0001, options.minimumVelocity ?? 0.01);
    this.#wheelZoomRate = Math.max(0.0001, options.wheelZoomRate ?? 0.0014);
    this.#onManualVerticalMovement = options.onManualVerticalMovement ?? (() => undefined);
    this.#onZoomRequest = options.onZoomRequest ?? ((scale) => scale);
    this.#onZoomEnd = options.onZoomEnd ?? (() => undefined);
    this.root.eventMode = "passive";
    this.root.scale.set(this.#clampScale(options.initialScale));
    this.#addListeners();
  }

  get activePointers() {
    return this.#pointers.size;
  }

  get center(): ShowPixiCameraPoint {
    return this.screenToWorld({ x: this.#width / 2, y: this.#height / 2 });
  }

  get destroyed() {
    return this.#destroyed;
  }

  get inputEnabled() {
    return this.#inputEnabled;
  }

  get left() {
    return -this.root.position.x / this.scale;
  }

  get listenerCount() {
    return this.#listenerCount;
  }

  get moving() {
    return this.#dragging || Math.hypot(this.#velocityX, this.#velocityY) >= (
      this.#minimumVelocity
    ) || Math.abs(this.#wheelPanRemainingY) >= wheelPanStopDistance;
  }

  get scale() {
    return Math.max(0.0001, this.root.scale.x);
  }

  get top() {
    return -this.root.position.y / this.scale;
  }

  get zooming() {
    return this.#pinch !== null || this.#wheelIdleMs > 0;
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.setInputEnabled(false);
    this.#removeListeners();
    this.root.removeAllListeners();
  }

  getVisibleBounds(): ShowPixiCameraBounds {
    return {
      x: this.left,
      y: this.top,
      width: this.#width / this.scale,
      height: this.#height / this.scale
    };
  }

  moveCenter(point: ShowPixiCameraPoint) {
    this.root.position.set(
      this.#width / 2 - point.x * this.scale,
      this.#height / 2 - point.y * this.scale
    );
  }

  moveCorner(x: number, y: number) {
    this.root.position.set(-x * this.scale, -y * this.scale);
  }

  panScreen(deltaX: number, deltaY: number) {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    this.root.position.set(
      this.root.position.x + deltaX,
      this.root.position.y + deltaY
    );
  }

  resize(width: number, height: number) {
    const center = this.center;
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);
    this.moveCenter(center);
  }

  screenToWorld(point: ShowPixiCameraPoint): ShowPixiCameraPoint {
    return {
      x: (point.x - this.root.position.x) / this.scale,
      y: (point.y - this.root.position.y) / this.scale
    };
  }

  setInputEnabled(enabled: boolean) {
    if (this.#destroyed && enabled) return;
    this.#inputEnabled = enabled;
    if (enabled) return;
    for (const pointerId of this.#pointers.keys()) {
      try {
        if (this.#element.hasPointerCapture?.(pointerId)) {
          this.#element.releasePointerCapture?.(pointerId);
        }
      } catch {
        // The browser may release captures before a visibility transition.
      }
    }
    this.#pointers.clear();
    this.#dragging = false;
    this.#pinch = null;
    this.#velocityX = 0;
    this.#velocityY = 0;
    this.#wheelPanRemainingY = 0;
    this.#wheelIdleMs = 0;
  }

  setScaleLimits(minimumScale: number, maximumScale: number) {
    const center = this.center;
    this.#minimumScale = Math.max(0.0001, minimumScale);
    this.#maximumScale = Math.max(this.#minimumScale, maximumScale);
    this.root.scale.set(this.#clampScale(this.scale));
    this.moveCenter(center);
  }

  setZoom(scale: number, anchor = { x: this.#width / 2, y: this.#height / 2 }) {
    const worldAnchor = this.screenToWorld(anchor);
    this.#setScaleAtWorldAnchor(scale, anchor, worldAnchor);
  }

  update(elapsedMs: number) {
    if (this.#destroyed) return;
    const elapsed = clamp(elapsedMs, 0, 64);
    if (this.#wheelIdleMs > 0) {
      this.#wheelIdleMs = Math.max(0, this.#wheelIdleMs - elapsed);
      if (this.#wheelIdleMs === 0) this.#onZoomEnd(this.scale);
    }
    if (!this.#inputEnabled || this.#dragging || this.#pinch) return;
    if (Math.abs(this.#wheelPanRemainingY) >= wheelPanStopDistance) {
      const progress = 1 - Math.exp(-elapsed / wheelPanResponseMs);
      const deltaY = this.#wheelPanRemainingY * progress;
      this.#panFromInput(0, deltaY);
      this.#wheelPanRemainingY -= deltaY;
      if (Math.abs(this.#wheelPanRemainingY) < wheelPanStopDistance) {
        this.#panFromInput(0, this.#wheelPanRemainingY);
        this.#wheelPanRemainingY = 0;
      }
    } else {
      this.#wheelPanRemainingY = 0;
    }
    if (Math.hypot(this.#velocityX, this.#velocityY) < this.#minimumVelocity) {
      this.#velocityX = 0;
      this.#velocityY = 0;
      return;
    }
    this.#panFromInput(
      this.#velocityX * elapsed,
      this.#velocityY * elapsed,
      this.#dragPointerType
    );
    const decay = this.#friction ** (elapsed / (1_000 / 60));
    this.#velocityX *= decay;
    this.#velocityY *= decay;
  }

  worldToScreen(point: ShowPixiCameraPoint): ShowPixiCameraPoint {
    return {
      x: point.x * this.scale + this.root.position.x,
      y: point.y * this.scale + this.root.position.y
    };
  }

  #addListeners() {
    this.#element.addEventListener("pointerdown", this.#handlePointerDown, {
      passive: false
    });
    this.#element.addEventListener("pointermove", this.#handlePointerMove, {
      passive: false
    });
    this.#element.addEventListener("pointerup", this.#handlePointerUp, {
      passive: false
    });
    this.#element.addEventListener("pointercancel", this.#handlePointerUp, {
      passive: false
    });
    this.#element.addEventListener("lostpointercapture", this.#handlePointerUp, {
      passive: false
    });
    this.#element.addEventListener("wheel", this.#handleWheel, { passive: false });
    this.#element.addEventListener("contextmenu", this.#handleContextMenu);
    this.#listenerCount = 7;
  }

  #beginPinch() {
    const pair = this.#pointerPair();
    if (!pair) return;
    const anchor = midpoint(pair[0].point, pair[1].point);
    this.#pinch = {
      distance: Math.max(1, distance(pair[0].point, pair[1].point)),
      scale: this.scale,
      worldAnchor: this.screenToWorld(anchor)
    };
    this.#dragging = false;
    this.#velocityX = 0;
    this.#velocityY = 0;
  }

  #clampScale(scale: number) {
    const finiteScale = Number.isFinite(scale) ? scale : this.#minimumScale;
    return clamp(finiteScale, this.#minimumScale, this.#maximumScale);
  }

  #eventPoint(clientX: number, clientY: number): ShowPixiCameraPoint {
    const bounds = this.#element.getBoundingClientRect();
    const scaleX = bounds.width > 0 ? this.#width / bounds.width : 1;
    const scaleY = bounds.height > 0 ? this.#height / bounds.height : 1;
    return {
      x: (clientX - bounds.left) * scaleX,
      y: (clientY - bounds.top) * scaleY
    };
  }

  #panFromInput(deltaX: number, deltaY: number, pointerType?: string) {
    this.panScreen(deltaX, deltaY);
    // Only drag, wheel pan and inertia contribute navigation movement.
    // Zoom anchoring and automatic cruise use separate transform paths.
    const verticalMovement = -deltaY / this.scale;
    if (Math.abs(verticalMovement) > 0.01) {
      this.#onManualVerticalMovement(verticalMovement, pointerType);
    }
  }

  #pointerPair() {
    const values = [...this.#pointers.values()];
    return values.length >= 2
      ? [values[0], values[1]] as const
      : null;
  }

  #removeListeners() {
    this.#element.removeEventListener("pointerdown", this.#handlePointerDown);
    this.#element.removeEventListener("pointermove", this.#handlePointerMove);
    this.#element.removeEventListener("pointerup", this.#handlePointerUp);
    this.#element.removeEventListener("pointercancel", this.#handlePointerUp);
    this.#element.removeEventListener("lostpointercapture", this.#handlePointerUp);
    this.#element.removeEventListener("wheel", this.#handleWheel);
    this.#element.removeEventListener("contextmenu", this.#handleContextMenu);
    this.#listenerCount = 0;
  }

  #setScaleAtWorldAnchor(
    scale: number,
    screenAnchor: ShowPixiCameraPoint,
    worldAnchor: ShowPixiCameraPoint
  ) {
    const nextScale = this.#clampScale(scale);
    this.root.scale.set(nextScale);
    this.root.position.set(
      screenAnchor.x - worldAnchor.x * nextScale,
      screenAnchor.y - worldAnchor.y * nextScale
    );
  }
}
