import {
  Color,
  Container,
  Graphics,
  PerspectiveMesh,
  Rectangle,
  type FederatedPointerEvent,
  type Renderer,
  type Texture
} from "pixi.js";
import { calculatePointerMagnet } from "../../../lib/ui/pointer-magnet.js";
import type { ShowImage } from "../show-layout.js";
import { ShowPixiEdgeLight } from "./show-pixi-edge-light.js";
import {
  type ShowPixiTextureCache,
  type ShowPixiTextureLease
} from "./show-pixi-texture-cache.js";

const pointerDistance = (
  event: FederatedPointerEvent,
  start: { x: number; y: number }
) => Math.hypot(event.global.x - start.x, event.global.y - start.y);

const portraitMagnetOptions = {
  maximumAngleDegrees: 8,
  maximumShadowOffsetPixels: 0
} as const;
const landscapeMagnetOptions = {
  maximumAngleDegrees: 10,
  maximumShadowOffsetPixels: 0
} as const;
const perspectiveDistancePixels = 1_200;

type CardPaint = { color: number; alpha: number };
type CardPalette = {
  border: CardPaint;
  activeBorder: CardPaint;
  glow: CardPaint;
  edgeLight: CardPaint;
  placeholder: CardPaint;
};
const cardPalettes = new WeakMap<Renderer, CardPalette>();

function cardPalette(renderer: Renderer) {
  const cached = cardPalettes.get(renderer);
  if (cached) return cached;
  const styles = getComputedStyle(document.documentElement);
  const paint = (token: string): CardPaint => {
    const color = new Color(styles.getPropertyValue(token).trim());
    return { color: color.toNumber(), alpha: color.alpha };
  };
  const palette = {
    border: paint("--public-color-border-default"),
    activeBorder: paint("--public-color-gallery-tile-border-hover"),
    glow: paint("--public-shadow-gallery-tile-hover"),
    edgeLight: paint("--public-color-card-edge-light"),
    placeholder: paint("--public-color-gallery-tile-surface")
  };
  cardPalettes.set(renderer, palette);
  return palette;
}

// Approximate the gallery's 8px CSS shadow with one-pixel outer bands.
// The Gaussian tail ends at 12px (three sigma); no per-frame blur filter or
// additional full-card render texture is needed.
const hoverGlowFalloff = [
  .4503, .3538, .2660, .1908, .1303, .0846,
  .0521, .0304, .0168, .0088, .0043, .0020
] as const;
const cardSurfacePaddingPixels = hoverGlowFalloff.length + 1;

type PerspectiveOwner = {
  owner: object;
  reset: () => void;
};

export class ShowPixiPerspectiveCoordinator {
  #active: PerspectiveOwner | null = null;

  claim(owner: object, reset: () => void) {
    if (this.#active?.owner === owner) return;
    const previous = this.#active;
    this.#active = { owner, reset };
    previous?.reset();
  }

  release(owner: object) {
    if (this.#active?.owner === owner) this.#active = null;
  }
}

export function showPixiTextureLod(
  image: ShowImage,
  renderedWidth: number,
  targetRatio: number
) {
  const sourceRatio = image.width > 0 && image.height > 0
    ? image.height / image.width
    : 1;
  const ratio = Number.isFinite(targetRatio) && targetRatio > 0
    ? targetRatio
    : sourceRatio;
  const renderedPixels = renderedWidth * Math.max(1, devicePixelRatio);
  const edge = renderedPixels <= 140 ? 128 : renderedPixels <= 300 ? 256 : 512;
  const pixelHeight = Math.max(1, Math.round(edge * ratio));
  // Keep the target aspect ratio even for uncommon panoramas or tall images.
  // When the height reaches the cache ceiling, reduce width instead of
  // stretching a capped bitmap back over the card geometry.
  const pixelWidth = pixelHeight > 1_024
    ? Math.max(1, Math.round(1_024 / ratio))
    : edge;
  return {
    pixelWidth,
    pixelHeight: Math.min(1_024, pixelHeight),
    sourceRatio
  };
}

export class ShowPixiCard {
  readonly root = new Container();
  readonly visual = new Container();
  readonly surface = new Graphics();
  readonly #hitArea = new Rectangle();
  key = "";
  image: ShowImage | null = null;
  width = 1;
  height = 1;
  targetWidth = 1;
  targetHeight = 1;
  baseRotation = 0;
  visible = false;
  #destroyed = false;
  #focused = false;
  #hovered = false;
  #interactionEnabled = true;
  #perspectiveEnabled = true;
  #lease: ShowPixiTextureLease | null = null;
  #pendingLease: ShowPixiTextureLease | null = null;
  #cancelTextureWait: (() => void) | null = null;
  #textureKey = "";
  #texture: Texture | null = null;
  #renderScale = 1;
  #surfaceSignature = "";
  #surfaceBorderVisible = true;
  #pointerStart: { x: number; y: number; pointerId: number; dragged: boolean } | null = null;
  #tiltX = 0;
  #tiltY = 0;
  #tiltTargetX = 0;
  #tiltTargetY = 0;
  #perspectiveMesh: PerspectiveMesh | null = null;
  #edgeLight: ShowPixiEdgeLight | null = null;
  readonly #perspectiveCorners = new Float32Array(8);
  #perspectiveTexture: Texture | null = null;
  #perspectiveSourceSignature = "";
  #perspectiveUnavailableSignature = "";
  #onOpen: (image: ShowImage, key: string) => void;
  readonly #renderer: Renderer;
  readonly #palette: CardPalette;
  readonly #perspectiveCoordinator: ShowPixiPerspectiveCoordinator;
  #textureCache: ShowPixiTextureCache;

  constructor(
    textureCache: ShowPixiTextureCache,
    onOpen: (image: ShowImage, key: string) => void,
    renderer: Renderer,
    perspectiveCoordinator: ShowPixiPerspectiveCoordinator
  ) {
    this.#textureCache = textureCache;
    this.#onOpen = onOpen;
    this.#renderer = renderer;
    this.#palette = cardPalette(renderer);
    this.#perspectiveCoordinator = perspectiveCoordinator;
    this.root.sortableChildren = false;
    this.root.eventMode = "dynamic";
    this.root.cursor = "pointer";
    this.root.hitArea = this.#hitArea;
    this.visual.addChild(this.surface);
    this.root.addChild(this.visual);
    this.root.on("pointerover", (event) => {
      this.#hovered = event.pointerType === "mouse";
      if (this.#hovered && this.#perspectiveEnabled) {
        this.#perspectiveUnavailableSignature = "";
        this.#perspectiveCoordinator.claim(
          this,
          () => this.#cancelPointerPerspective()
        );
        this.#updateTiltTarget(event);
      }
      this.#updateDepth();
    });
    this.root.on("pointerout", () => {
      this.#hovered = false;
      this.#pointerStart = null;
      this.#resetTiltTarget();
      this.#updateDepth();
    });
    this.root.on("pointermove", (event) => {
      const start = this.#pointerStart;
      if (start && event.pointerId === start.pointerId && pointerDistance(event, start) > 6) {
        start.dragged = true;
      }
      if (
        event.pointerType !== "mouse"
        || !this.#hovered
        || !this.#perspectiveEnabled
      ) return;
      this.#updateTiltTarget(event);
    });
    this.root.on("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (event.isPrimary === false) {
        this.#pointerStart = null;
        return;
      }
      this.#pointerStart = {
        x: event.global.x, y: event.global.y, pointerId: event.pointerId, dragged: false
      };
    });
    this.root.on("pointerup", (event) => {
      const start = this.#pointerStart;
      this.#pointerStart = null;
      if (
        !start || start.dragged || event.pointerId !== start.pointerId
        || pointerDistance(event, start) > 6 || !this.image
      ) return;
      this.#onOpen(this.image, this.key);
    });
    this.root.on("pointerupoutside", () => {
      this.#pointerStart = null;
    });
  }

  assign(
    key: string,
    image: ShowImage,
    width: number,
    height: number,
    rotation: number,
    smoothSize = false,
    textureRenderedWidth = width,
    renderScale = 1
  ) {
    const identityChanged = this.image?.id !== image.id || this.key !== key;
    const resolvedTextureUrl = image.thumb_url;
    const lod = showPixiTextureLod(
      image,
      textureRenderedWidth,
      height / Math.max(1, width)
    );
    const nextTextureKey = `${resolvedTextureUrl}\n${lod.pixelWidth}x${lod.pixelHeight}`;
    const textureChanged = identityChanged || this.#textureKey !== nextTextureKey;
    this.key = key;
    this.image = image;
    this.baseRotation = rotation;
    this.root.rotation = this.baseRotation;
    this.setRenderScale(renderScale);
    this.targetWidth = Math.max(1, width);
    this.targetHeight = Math.max(1, height);
    if (!smoothSize || this.width <= 1 || this.height <= 1) {
      this.width = this.targetWidth;
      this.height = this.targetHeight;
    }
    if (identityChanged) {
      this.#focused = false;
      this.#cancelPointerPerspective();
    }
    this.#applyGeometry();
    if (!textureChanged) return;
    this.#cancelTextureWait?.();
    this.#cancelTextureWait = null;
    this.#pendingLease?.release();
    this.#pendingLease = null;
    this.#textureKey = nextTextureKey;
    if (identityChanged) {
      this.#lease?.release();
      this.#lease = null;
      this.#texture = null;
      this.#surfaceSignature = "";
      this.#applyGeometry();
    }
    const generationKey = `${key}:${image.id}:${nextTextureKey}`;
    this.#loadTexture(resolvedTextureUrl, lod, generationKey);
  }

  #loadTexture(
    url: string,
    lod: ReturnType<typeof showPixiTextureLod>,
    generationKey: string
  ) {
    if (
      this.#destroyed
      || generationKey !== `${this.key}:${this.image?.id ?? ""}:${this.#textureKey}`
    ) return;
    let pendingLease: ShowPixiTextureLease | null = null;
    pendingLease = this.#textureCache.acquire(
      url,
      lod,
      (texture, retryable) => {
        if (
          this.#destroyed
          || generationKey !== `${this.key}:${this.image?.id ?? ""}:${this.#textureKey}`
        ) {
          pendingLease?.release();
          return;
        }
        this.#pendingLease = null;
        if (!texture) {
          pendingLease?.release();
          if (retryable) {
            // Resume on capacity release or an explicit resource recovery edge.
            // Retrying the lease must not reassign the card's moving geometry.
            this.#cancelTextureWait = this.#textureCache.whenAvailable(url, () => {
              this.#cancelTextureWait = null;
              this.#loadTexture(url, lod, generationKey);
            });
          }
          return;
        }
        this.#lease?.release();
        this.#lease = pendingLease;
        this.#texture = texture;
        this.#surfaceSignature = "";
        this.#applyGeometry();
      }
    );
    this.#pendingLease = pendingLease;
  }

  setFocused(focused: boolean) {
    if (this.#focused === focused) return;
    this.#focused = focused;
    this.#updateDepth();
  }

  get isHovered() {
    return this.#hovered;
  }

  get isInteractionActive() {
    return this.#focused || this.#hovered;
  }

  get isTextureReady() {
    return this.#texture !== null;
  }

  setPerspectiveEnabled(enabled: boolean) {
    if (this.#perspectiveEnabled === enabled) return;
    this.#perspectiveEnabled = enabled;
    if (!enabled) {
      this.#tiltX = 0;
      this.#tiltY = 0;
      this.#resetTiltTarget();
      this.#releasePerspectiveSurface();
      this.#perspectiveCoordinator.release(this);
      return;
    }
    if (!this.#hovered) return;
    this.#perspectiveUnavailableSignature = "";
    this.#perspectiveCoordinator.claim(
      this,
      () => this.#cancelPointerPerspective()
    );
  }

  setRenderScale(renderScale: number) {
    const nextScale = Math.max(0.01, renderScale);
    if (Math.abs(nextScale - this.#renderScale) < 0.00005) return;
    this.#renderScale = nextScale;
    this.#surfaceSignature = "";
  }

  setInteractionEnabled(enabled: boolean) {
    this.#interactionEnabled = enabled;
    this.root.eventMode = this.visible && enabled ? "dynamic" : "none";
    if (!enabled) {
      this.clearPointerHover();
    }
  }

  clearPointerHover() {
    this.#cancelPointerPerspective();
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.root.visible = visible;
    this.root.eventMode = visible && this.#interactionEnabled ? "dynamic" : "none";
    if (!visible && this.#hovered) this.#cancelPointerPerspective();
  }

  update(elapsedMs: number, smoothSize = false) {
    if (smoothSize) {
      const progress = 1 - Math.exp(-Math.max(0, elapsedMs) / 180);
      this.width += (this.targetWidth - this.width) * progress;
      this.height += (this.targetHeight - this.height) * progress;
      if (Math.abs(this.targetWidth - this.width) < 0.02) {
        this.width = this.targetWidth;
      }
      if (Math.abs(this.targetHeight - this.height) < 0.02) {
        this.height = this.targetHeight;
      }
    }
    const portrait = (this.image?.height ?? 0) > (this.image?.width ?? 0);
    const targetScale = this.#focused || this.#hovered
      ? portrait ? 1.08 : 1.1
      : 1;
    const scaleProgress = 1 - Math.exp(-Math.max(0, elapsedMs) / 95);
    const nextScale = this.root.scale.x
      + (targetScale - this.root.scale.x) * scaleProgress;
    this.root.scale.set(nextScale);
    this.#applyGeometry();
    const tiltProgress = 1 - Math.exp(-Math.max(0, elapsedMs) / 110);
    this.#tiltX += (this.#tiltTargetX - this.#tiltX) * tiltProgress;
    this.#tiltY += (this.#tiltTargetY - this.#tiltY) * tiltProgress;
    if (
      this.#perspectiveEnabled
      && (
        this.#hovered
        || Math.abs(this.#tiltX) > 0.001
        || Math.abs(this.#tiltY) > 0.001
      )
    ) {
      this.#applyPointerPerspective(portrait);
    } else {
      this.#tiltX = 0;
      this.#tiltY = 0;
      this.#releasePerspectiveSurface();
      this.#perspectiveCoordinator.release(this);
    }
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#cancelTextureWait?.();
    this.#cancelTextureWait = null;
    this.#cancelPointerPerspective();
    this.#lease?.release();
    this.#lease = null;
    this.#pendingLease?.release();
    this.#pendingLease = null;
    this.#textureKey = "";
    this.#texture = null;
    this.#surfaceSignature = "";
    this.root.removeAllListeners();
    this.root.destroy({ children: true, texture: false, textureSource: false });
    this.image = null;
  }

  #applyGeometry() {
    const active = this.#focused || this.#hovered;
    const width = Math.max(1, this.width);
    const height = Math.max(1, this.height);
    if (
      this.#surfaceSignature
      && this.#hitArea.width === width
      && this.#hitArea.height === height
    ) return;
    this.#hitArea.x = -width / 2;
    this.#hitArea.y = -height / 2;
    this.#hitArea.width = width;
    this.#hitArea.height = height;
    const borderWidth = Math.min(
      width / 2,
      height / 2,
      1 / this.#renderScale
    );
    const radius = Math.min(
      width / 2,
      height / 2,
      6 / this.#renderScale
    );
    const signature = [
      width.toFixed(2),
      height.toFixed(2),
      this.#renderScale.toFixed(4),
      active ? "active" : "resting",
      this.#texture?.uid ?? "placeholder"
    ].join(":");
    if (signature !== this.#surfaceSignature) {
      const innerWidth = Math.max(0, width - borderWidth * 2);
      const innerHeight = Math.max(0, height - borderWidth * 2);
      const innerRadius = Math.max(0, radius - borderWidth);
      this.surface.clear();
      if (active) {
        const bandWidth = 1 / this.#renderScale;
        for (let index = 0; index < hoverGlowFalloff.length; index += 1) {
          const outset = (index + 0.5) * bandWidth;
          this.surface
            .roundRect(
              -width / 2 - outset,
              -height / 2 - outset,
              width + outset * 2,
              height + outset * 2,
              radius + outset
            )
            .stroke({
              width: bandWidth,
              color: this.#palette.glow.color,
              alpha: this.#palette.glow.alpha * hoverGlowFalloff[index]!
            });
        }
      }
      this.surface
        .roundRect(-width / 2, -height / 2, width, height, radius)
        .fill(this.#surfaceBorderVisible
          ? active ? this.#palette.activeBorder : this.#palette.border
          : { color: 0, alpha: 0 });
      if (innerWidth > 0 && innerHeight > 0) {
        const inner = this.surface.roundRect(
          -innerWidth / 2,
          -innerHeight / 2,
          innerWidth,
          innerHeight,
          innerRadius
        );
        if (this.#texture) {
          inner.fill({
            texture: this.#texture,
            textureSpace: "local"
          });
        } else {
          inner.fill(this.#palette.placeholder);
        }
      }
      this.#surfaceSignature = signature;
    }
  }

  #updateDepth() {
    const active = this.#focused || this.#hovered;
    if (!this.#hovered) this.#releaseEdgeLight();
    this.root.zIndex = active ? 100_000 : 1;
    this.#surfaceSignature = "";
    this.#applyGeometry();
  }

  #updateTiltTarget(event: FederatedPointerEvent) {
    const local = this.root.toLocal(event.global);
    // Remove the current hover scale from the hit coordinate so the tilt uses
    // the same untransformed layout dimensions as the former DOM card.
    const hoverScale = Math.max(0.01, this.root.scale.x);
    this.#tiltTargetX = Math.max(-1, Math.min(
      1,
      local.x * hoverScale / Math.max(0.5, this.width / 2)
    ));
    this.#tiltTargetY = Math.max(-1, Math.min(
      1,
      local.y * hoverScale / Math.max(0.5, this.height / 2)
    ));
  }

  #resetTiltTarget() {
    this.#tiltTargetX = 0;
    this.#tiltTargetY = 0;
  }

  #applyPointerPerspective(portrait: boolean) {
    const mesh = this.#ensurePerspectiveSurface();
    if (!mesh) return;
    const magnet = calculatePointerMagnet(
      this.#tiltX,
      this.#tiltY,
      portrait ? portraitMagnetOptions : landscapeMagnetOptions
    );
    const angle = magnet.angleDegrees * Math.PI / 180;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const oneMinusCosine = 1 - cosine;
    const axisX = magnet.axisX;
    const axisY = magnet.axisY;
    const hoverScale = Math.max(0.01, this.root.scale.x);
    const perspective = perspectiveDistancePixels
      / Math.max(0.01, this.#renderScale * hoverScale);
    const project = (x: number, y: number, output: Float32Array, offset: number) => {
      const axisDot = axisX * x + axisY * y;
      const rotatedX = x * cosine + axisX * axisDot * oneMinusCosine;
      const rotatedY = y * cosine + axisY * axisDot * oneMinusCosine;
      const rotatedZ = (axisX * y - axisY * x) * sine;
      const divisor = Math.max(0.35, 1 - rotatedZ / perspective);
      output[offset] = rotatedX / divisor;
      output[offset + 1] = rotatedY / divisor;
    };
    const padding = cardSurfacePaddingPixels / Math.max(0.01, this.#renderScale);
    const halfWidth = this.width / 2 + padding;
    const halfHeight = this.height / 2 + padding;
    const corners = this.#perspectiveCorners;
    project(-halfWidth, -halfHeight, corners, 0);
    project(halfWidth, -halfHeight, corners, 2);
    project(halfWidth, halfHeight, corners, 4);
    project(-halfWidth, halfHeight, corners, 6);
    mesh.setCorners(
      corners[0]!, corners[1]!, corners[2]!, corners[3]!,
      corners[4]!, corners[5]!, corners[6]!, corners[7]!
    );
    if (this.#hovered) {
      if (!this.#edgeLight) {
        this.#edgeLight = new ShowPixiEdgeLight(this.#palette.activeBorder, this.#palette.edgeLight);
        this.visual.addChild(this.#edgeLight.mesh);
      }
      this.#edgeLight.update(this.width, this.height, this.#renderScale, magnet, project);
    }
  }

  #ensurePerspectiveSurface() {
    const aspect = this.height / Math.max(1, this.width);
    const scaleBucket = Math.round(Math.log2(this.#renderScale) * 4);
    const sourceSignature = [
      this.#texture?.uid ?? "placeholder",
      this.#focused || this.#hovered ? "active" : "resting",
      this.#hovered ? "pointer-border" : "surface-border",
      aspect.toFixed(4),
      scaleBucket
    ].join(":");
    if (
      this.#perspectiveMesh
      && this.#perspectiveSourceSignature === sourceSignature
    ) return this.#perspectiveMesh;
    if (this.#perspectiveUnavailableSignature === sourceSignature) return null;
    this.#releasePerspectiveSurface();
    const padding = cardSurfacePaddingPixels / Math.max(0.01, this.#renderScale);
    const frame = new Rectangle(
      -this.width / 2 - padding,
      -this.height / 2 - padding,
      this.width + padding * 2,
      this.height + padding * 2
    );
    this.surface.visible = true;
    // The pointer mesh owns the same border footprint during hover. Exclude
    // it from the photo snapshot so the two renderers never double-paint it.
    this.#setSurfaceBorderVisible(!this.#hovered);
    let texture: Texture;
    try {
      texture = this.#renderer.generateTexture({
        target: this.surface,
        frame,
        resolution: Math.min(2, Math.max(
          1,
          (window.devicePixelRatio || 1) * this.#renderScale
        )),
        antialias: true,
        clearColor: [0, 0, 0, 0],
        textureSourceOptions: { scaleMode: "linear" }
      });
    } catch {
      this.#setSurfaceBorderVisible(true);
      this.#perspectiveUnavailableSignature = sourceSignature;
      return null;
    }
    const mesh = new PerspectiveMesh({
      texture,
      verticesX: 16,
      verticesY: 16,
      roundPixels: false
    });
    mesh.eventMode = "none";
    this.#perspectiveTexture = texture;
    this.#perspectiveMesh = mesh;
    this.#perspectiveSourceSignature = sourceSignature;
    this.visual.addChild(mesh);
    this.surface.visible = false;
    return mesh;
  }

  #releasePerspectiveSurface() {
    this.#releaseEdgeLight();
    const mesh = this.#perspectiveMesh;
    const texture = this.#perspectiveTexture;
    this.#perspectiveMesh = null;
    this.#perspectiveTexture = null;
    this.#perspectiveSourceSignature = "";
    if (mesh) {
      const geometry = mesh.geometry;
      mesh.parent?.removeChild(mesh);
      mesh.destroy({ texture: false, textureSource: false });
      // PerspectiveMesh creates this geometry exclusively for the card.
      // Mesh.destroy only detaches it; release its buffers with the snapshot.
      geometry.destroy();
    }
    texture?.destroy(true);
    this.surface.visible = true;
    this.#setSurfaceBorderVisible(true);
  }

  #setSurfaceBorderVisible(visible: boolean) {
    if (this.#surfaceBorderVisible === visible) return;
    this.#surfaceBorderVisible = visible;
    this.#surfaceSignature = "";
    if (!this.#destroyed) this.#applyGeometry();
  }

  #releaseEdgeLight() {
    this.#edgeLight?.destroy();
    this.#edgeLight = null;
  }

  #cancelPointerPerspective() {
    this.#hovered = false;
    this.#pointerStart = null;
    this.#tiltX = 0;
    this.#tiltY = 0;
    this.#resetTiltTarget();
    this.#releasePerspectiveSurface();
    this.#perspectiveCoordinator.release(this);
    if (!this.#destroyed) this.#updateDepth();
  }
}
