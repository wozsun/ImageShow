import { Container, type Renderer } from "pixi.js";
import type { ShowOrder } from "@imageshow/shared/browser";
import { ShowDataPool, shuffledShowImages } from "../show-data-pool.js";
import {
  showLayoutColumnWidth,
  type ShowCardSlot,
  type ShowImage
} from "../show-layout.js";
import { ShowWindowController } from "../show-window-controller.js";
import {
  ShowPixiCard,
  ShowPixiPerspectiveCoordinator
} from "./show-pixi-card.js";
import { ShowPixiCamera } from "./show-pixi-camera.js";
import {
  clampShowWaterfallColumns,
  showWaterfallDensity
} from "./show-pixi-layout.js";
import type { ShowPixiTextureCache } from "./show-pixi-texture-cache.js";
import type {
  ShowPixiSceneController,
  ShowPixiSceneOptions,
  ShowPixiSceneStats,
  ShowPixiVisibleItem
} from "./show-pixi-types.js";

type WaterfallSceneOptions = ShowPixiSceneOptions & {
  columns: number;
  inputElement: HTMLElement;
  speed: number;
  textureCache: ShowPixiTextureCache;
  onColumnsChange: (columns: number) => number;
  onManualVerticalMovement: (delta: number, pointerType?: string) => void;
};

const waterfallMaximumSprites = (width: number) => width <= 760 ? 640 : 1_600;
const waterfallOverscan = 0.35;
function intersectionArea(card: ShowCardSlot, width: number, height: number) {
  const left = Math.max(0, card.x);
  const top = Math.max(0, card.y);
  const right = Math.min(width, card.x + card.width);
  const bottom = Math.min(height, card.y + card.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

export class ShowPixiWaterfallScene implements ShowPixiSceneController {
  readonly kind = "waterfall" as const;
  readonly root: Container;
  readonly #camera: ShowPixiCamera;
  readonly #pool = new ShowDataPool(800);
  readonly #controller = new ShowWindowController(this.#pool);
  readonly #cards = new Map<string, ShowPixiCard>();
  readonly #perspectiveCoordinator = new ShowPixiPerspectiveCoordinator();
  readonly #textureCache: ShowPixiTextureCache;
  readonly #renderer: Renderer;
  readonly #onNeedImages: () => void;
  readonly #onOpen: (image: ShowImage, key: string) => void;
  readonly #onVisibleItems: (items: readonly ShowPixiVisibleItem[]) => void;
  readonly #onColumnsChange: (columns: number) => number;
  #width: number;
  #height: number;
  #columns: number;
  #targetScale: number;
  #speed: number;
  #running: boolean;
  #reducedMotion: boolean;
  #dataKey = "";
  #order: ShowOrder = "random";
  #imageCount = 0;
  #imageIds = new Set<string>();
  #lastReconcileAt = 0;
  #lastVisibleSignature = "";
  #recycledSprites = 0;
  #rejectedSprites = 0;
  #visibleSprites = 0;
  #coverageRatio = 0;
  #layoutRevision = 0;
  #inputEnabled = true;
  #destroyed = false;

  constructor(options: WaterfallSceneOptions) {
    this.#width = Math.max(1, options.width);
    this.#height = Math.max(1, options.height);
    this.#columns = this.#clampColumns(options.columns);
    this.#targetScale = this.#scaleForColumns(this.#columns);
    this.#speed = options.speed;
    this.#running = options.running;
    this.#reducedMotion = options.reducedMotion;
    this.#textureCache = options.textureCache;
    this.#renderer = options.renderer;
    this.#onNeedImages = options.onNeedImages;
    this.#onOpen = options.onOpen;
    this.#onVisibleItems = options.onVisibleItems;
    this.#onColumnsChange = options.onColumnsChange;
    this.#camera = new ShowPixiCamera({
      element: options.inputElement,
      width: this.#width,
      height: this.#height,
      initialScale: this.#targetScale,
      minimumScale: this.#scaleForColumns(this.#cameraColumnCeiling()),
      maximumScale: this.#scaleForColumns(this.#cameraColumnFloor()),
      friction: 0.92,
      minimumVelocity: 0.01,
      onManualVerticalMovement: options.onManualVerticalMovement,
      onZoomRequest: (scale) => this.#requestCameraZoom(scale),
      onZoomEnd: () => this.#syncColumnsFromCamera()
    });
    this.root = this.#camera.root;
    this.root.sortableChildren = true;
    this.#camera.moveCorner(-showLayoutColumnWidth / 2, 0);
    this.setImages(options.images, options.dataKey, options.order);
    this.#reconcile(true);
  }

  setColumns(columns: number) {
    this.#columns = this.#clampColumns(columns);
    this.#targetScale = this.#scaleForColumns(this.#columns);
    this.#setCardPerspectiveEnabled(this.#allowsPerspective(this.#columns));
    this.#installScaleClamp();
  }

  setSpeed(speed: number) {
    this.#speed = Math.max(0, Number.isFinite(speed) ? speed : 0);
  }

  resize(width: number, height: number) {
    const center = this.#camera.center;
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);
    this.#columns = this.#clampColumns(this.#columns);
    this.#targetScale = this.#scaleForColumns(this.#columns);
    this.#camera.resize(this.#width, this.#height);
    this.#installScaleClamp();
    this.#camera.setZoom(this.#targetScale);
    this.#camera.moveCenter(center);
    this.#reconcile(true);
  }

  setImages(images: readonly ShowImage[], dataKey: string, order: ShowOrder) {
    this.#lastVisibleSignature = "";
    const arranged = order === "random" ? shuffledShowImages(images) : [...images];
    const replacing = this.#dataKey !== dataKey || this.#order !== order;
    const imageMap = new Map(arranged.map((image) => [image.id, image]));
    this.#dataKey = dataKey;
    this.#order = order;
    this.#imageCount = arranged.length;
    if (replacing) {
      this.#clearCards();
      this.#controller.clear();
      this.#pool.reset(arranged);
    } else {
      for (const imageId of this.#imageIds) {
        if (!imageMap.has(imageId)) this.#controller.removeImage(imageId);
      }
      this.#pool.add(arranged);
      this.#controller.updateImages(imageMap);
    }
    this.#imageIds = new Set(imageMap.keys());
    this.#reconcile(true);
  }

  setInputEnabled(enabled: boolean) {
    this.#inputEnabled = enabled;
    this.#camera.setInputEnabled(enabled);
    for (const card of this.#cards.values()) card.setInteractionEnabled(enabled);
  }

  setMotion(running: boolean, reducedMotion: boolean) {
    this.#running = running;
    this.#reducedMotion = reducedMotion;
  }

  focusCard(key: string | null) {
    for (const card of this.#cards.values()) {
      card.setFocused(card.key === key);
    }
  }

  clearPointerHover() {
    for (const card of this.#cards.values()) card.clearPointerHover();
  }

  update(elapsedMs: number) {
    if (this.#destroyed) return;
    const elapsed = Math.min(48, Math.max(0, elapsedMs));
    this.#camera.update(elapsed);
    const scaleDelta = this.#targetScale - this.#camera.scale;
    if (Math.abs(scaleDelta) > 0.00005 && !this.#camera.zooming) {
      const progress = 1 - Math.exp(-elapsed / 150);
      this.#camera.setZoom(
        this.#camera.scale + scaleDelta * progress
      );
    }
    if (
      this.#running
      && !this.#reducedMotion
      && !this.#camera.moving
      && !this.#camera.zooming
    ) {
      this.#camera.panScreen(0, -this.#speed * elapsed / 1_000);
    }
    this.#reconcile(false);
    for (const card of this.#cards.values()) {
      card.setRenderScale(this.#camera.scale);
      card.update(elapsed);
    }
  }

  stats(): ShowPixiSceneStats {
    const cameraActive = !this.#destroyed && !this.#camera.destroyed;
    return {
      activeSprites: this.#cards.size,
      visibleSprites: this.#visibleSprites,
      retainedDtos: this.#pool.snapshot().retained,
      recycledSprites: this.#recycledSprites,
      rejectedSprites: this.#rejectedSprites,
      overlapRatio: 0,
      coverageRatio: this.#coverageRatio,
      horizontalConcentration: 0,
      layoutRevision: this.#layoutRevision,
      inputEnabled: this.#inputEnabled && this.#camera.inputEnabled,
      inputListenerCount: this.#camera.listenerCount,
      activePointers: this.#camera.activePointers,
      waterfallColumns: this.#columns,
      waterfallCameraX: cameraActive ? this.#camera.left : null,
      waterfallCameraY: cameraActive ? this.#camera.top : null,
      waterfallScale: cameraActive ? this.#camera.scale : null,
      floatSizeIndex: null,
      floatMeanY: null
    };
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#onVisibleItems([]);
    this.#clearCards();
    this.#controller.clear();
    this.#pool.clear();
    this.#imageIds.clear();
    this.#camera.destroy();
    this.root.destroy({ children: true });
  }

  #reconcile(force: boolean) {
    const now = performance.now();
    if (!force && now - this.#lastReconcileAt < 72) return;
    this.#lastReconcileAt = now;
    const scale = this.#camera.scale;
    const perspectiveEnabled = this.#allowsPerspective(
      this.#width / (scale * showLayoutColumnWidth)
    );
    const bounds = this.#camera.getVisibleBounds();
    this.#controller.reconcile(
      { x: bounds.x * scale, y: bounds.y * scale },
      { width: this.#width, height: this.#height },
      scale,
      {
        horizontalOverscanScreens: waterfallOverscan,
        verticalOverscanScreens: waterfallOverscan
      }
    );
    const snapshot = this.#controller.snapshot();
    this.#layoutRevision = snapshot.revision;
    const centerX = (snapshot.window.visible.left + snapshot.window.visible.right) / 2;
    const centerY = (snapshot.window.visible.top + snapshot.window.visible.bottom) / 2;
    const maximum = waterfallMaximumSprites(this.#width);
    const desired = [...snapshot.cards].sort((left, right) => (
      Number(right.visible) - Number(left.visible)
      || Math.hypot(
        left.x + left.width / 2 - centerX,
        left.y + left.height / 2 - centerY
      ) - Math.hypot(
        right.x + right.width / 2 - centerX,
        right.y + right.height / 2 - centerY
      )
    )).slice(0, maximum);
    this.#rejectedSprites = Math.max(0, snapshot.cards.length - desired.length);
    const retainedKeys = new Set(desired.map((slot) => slot.key));
    for (const [key, card] of this.#cards) {
      if (retainedKeys.has(key)) continue;
      this.root.removeChild(card.root);
      card.destroy();
      this.#cards.delete(key);
      this.#recycledSprites += 1;
    }
    let visibleSprites = 0;
    let visibleArea = 0;
    const visibleItems: ShowPixiVisibleItem[] = [];
    for (const slot of desired) {
      let card = this.#cards.get(slot.key);
      if (!card) {
        card = new ShowPixiCard(
          this.#textureCache,
          this.#onOpen,
          this.#renderer,
          this.#perspectiveCoordinator
        );
        this.#cards.set(slot.key, card);
        this.root.addChild(card.root);
      }
      card.setPerspectiveEnabled(perspectiveEnabled);
      card.assign(
        slot.key,
        slot.image,
        slot.width,
        slot.height,
        slot.angle * Math.PI / 180,
        false,
        slot.width * scale,
        scale
      );
      card.root.position.set(
        slot.x + slot.width / 2,
        slot.y + slot.height / 2
      );
      card.setVisible(true);
      if (slot.visible) {
        visibleSprites += 1;
        if (visibleItems.length < 96) {
          visibleItems.push({ key: slot.key, image: slot.image });
        }
        visibleArea += intersectionArea({
          ...slot,
          x: (slot.x - snapshot.window.visible.left) * scale,
          y: (slot.y - snapshot.window.visible.top) * scale,
          width: slot.width * scale,
          height: slot.height * scale
        }, this.#width, this.#height);
      }
    }
    this.#visibleSprites = visibleSprites;
    this.#coverageRatio = Math.min(
      1,
      visibleArea / Math.max(1, this.#width * this.#height)
    );
    const signature = visibleItems.map((item) => `${item.key}:${item.image.id}`).join("|");
    if (signature !== this.#lastVisibleSignature) {
      this.#lastVisibleSignature = signature;
      this.#onVisibleItems(visibleItems);
    }
    const poolStats = this.#pool.snapshot();
    if ((snapshot.missingCards > 0 || poolStats.available < 96) && this.#imageCount < 800) {
      this.#onNeedImages();
    }
  }

  #clearCards() {
    for (const card of this.#cards.values()) {
      card.root.parent?.removeChild(card.root);
      card.destroy();
    }
    this.#cards.clear();
    this.#lastVisibleSignature = "";
  }

  #clampColumns(columns: number) {
    return clampShowWaterfallColumns(
      Number.isFinite(columns) ? columns : showWaterfallDensity(this.#width).defaultColumns,
      showWaterfallDensity(this.#width)
    );
  }

  #scaleForColumns(columns: number) {
    return this.#width / (Math.max(0.5, columns) * showLayoutColumnWidth);
  }

  #allowsPerspective(columns: number) {
    return columns <= showWaterfallDensity(this.#width).galleryColumns * 5
      + 0.001;
  }

  #setCardPerspectiveEnabled(enabled: boolean) {
    for (const card of this.#cards.values()) {
      card.setPerspectiveEnabled(enabled);
    }
  }

  #installScaleClamp() {
    this.#camera.setScaleLimits(
      this.#scaleForColumns(this.#cameraColumnCeiling()),
      this.#scaleForColumns(this.#cameraColumnFloor())
    );
  }

  #cameraColumnCeiling() {
    const density = showWaterfallDensity(this.#width);
    const precisionBoundary = density.galleryColumns * 5;
    const nextCeiling = this.#columns >= precisionBoundary - 0.001
      ? this.#columns + 3
      : Math.min(
        precisionBoundary,
        this.#columns + density.galleryColumns * 2
      );
    return Math.min(density.maximumColumns, nextCeiling);
  }

  #cameraColumnFloor() {
    const density = showWaterfallDensity(this.#width);
    const precisionBoundary = density.galleryColumns * 5;
    return this.#columns > precisionBoundary + 0.001
      ? Math.max(density.minimumColumns, this.#columns - 3)
      : density.minimumColumns;
  }

  #requestCameraZoom(scale: number) {
    const requestedColumns = this.#clampColumns(
      this.#width / (scale * showLayoutColumnWidth)
    );
    const warningColumns = showWaterfallDensity(this.#width).warningColumns;
    if (requestedColumns <= warningColumns + 0.001 || this.#columns > warningColumns + 0.001) {
      return scale;
    }
    // Ask before applying a zoom across the warning boundary. The page owns
    // confirmation; ordinary zoom frames stay inside the camera controller.
    this.#columns = this.#clampColumns(this.#onColumnsChange(requestedColumns));
    this.#targetScale = this.#scaleForColumns(this.#columns);
    return this.#targetScale;
  }

  #syncColumnsFromCamera() {
    if (this.#destroyed) return;
    const requestedColumns = this.#clampColumns(
      this.#width / (this.#camera.scale * showLayoutColumnWidth)
    );
    this.#columns = this.#clampColumns(this.#onColumnsChange(requestedColumns));
    this.#targetScale = this.#scaleForColumns(this.#columns);
    this.#installScaleClamp();
  }
}
