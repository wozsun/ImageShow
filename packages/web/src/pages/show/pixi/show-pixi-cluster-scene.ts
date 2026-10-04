import { Color, Container, Graphics, Sprite, Text, Texture, type Renderer } from "pixi.js";
import { imageVariantUrl, type ShowOrder } from "@imageshow/shared/browser";
import {
  clusterCardGrowth,
  clusterCardSide,
  clusterCardSize,
  clusterExpand,
  clusterRing,
  clusterRingPoint,
  clusterRingQuarterArc,
  clusterShownCount,
  clusterSphereLayout,
  clusterZoomRange,
  type ClusterPoint,
  type ClusterRing,
  type ClusterZoomRange
} from "../show-cluster-layout.js";
import type { ShowImage } from "../show-layout.js";
import type { ShowCluster } from "../useShowClusters.js";
import {
  ShowPixiCard,
  ShowPixiPerspectiveCoordinator,
  showPixiTextureLod
} from "./show-pixi-card.js";
import type { ShowPixiTextureCache } from "./show-pixi-texture-cache.js";
import type {
  ShowPixiSceneController,
  ShowPixiSceneOptions,
  ShowPixiSceneStats,
  ShowPixiVisibleItem
} from "./show-pixi-types.js";
import { emptyShowPixiSceneStats } from "./show-pixi-types.js";

export type ShowClusterFocus = { key: string; name: string; total: number };

/** 页面按钮与键盘对星群的操作：回到总览、切换相邻星团、缩放一格。 */
export type ShowClusterCommand =
  | { type: "exit" }
  | { type: "step"; direction: 1 | -1 }
  | { type: "zoom"; direction: 1 | -1 };

type ClusterSceneOptions = Pick<
  ShowPixiSceneOptions,
  "width" | "height" | "renderer" | "running" | "reducedMotion" | "onOpen" | "onVisibleItems"
> & {
  clusters: readonly ShowCluster[];
  dataKey: string;
  inputElement: HTMLElement;
  speed: number;
  textureCache: ShowPixiTextureCache;
  /** automatic：自动播放造成的进出，而不是访客的操作。 */
  onClusterFocusChange: (focus: ShowClusterFocus | null, automatic: boolean) => void;
  onManualVerticalMovement: (delta: number, pointerType?: string) => void;
  onNeedClusterImages: (key: string, retainedIds: readonly string[]) => void;
};

type Vector = [number, number, number];
type Rotation = number[];

type SlotState = ClusterPoint & {
  key: string;
  image: ShowImage;
  holder: Container | null;
  card: ShowPixiCard | null;
  alpha: number;
  facing: number;
  /** 这一帧画在屏幕上。 */
  drawn: boolean;
  /** 持有卡片与贴图：画在屏幕上，或就在视口外一圈、马上会进来。 */
  resident: boolean;
  interactive: boolean;
  /** 悬浮或聚焦过的先后序号（0 = 没有）：指针离开后仍叠在其他卡片之上，直到它转出画面。 */
  raised: number;
  engaged: boolean;
  /** 所展示的图片已被删除且没有可替换的图片：空着，直到轮换补上。 */
  vacant: boolean;
  width: number;
  height: number;
  screenWidth: number;
  /** 卡片应当按多大的倍数绘制（按 2^(1/4) 分档），以及它当前实际绘制的倍数。 */
  renderScale: number;
  assignedScale: number;
};

type ClusterState = {
  key: string;
  name: string;
  total: number;
  images: readonly ShowImage[];
  /** images 中下一张待上屏图片的位置；数组被替换后按最后消耗的图片重新定位。 */
  next: number;
  lastConsumedId: string;
  requested: boolean;
  slots: SlotState[];
  radius: number;
  /** 总览里只画一部分图片，球也按这个数量收小，疏密和画满时一样。 */
  overviewRadius: number;
  rotation: Rotation;
  axis: Vector;
  fling: [number, number];
  ringArc: number;
  ringIndex: number;
  position: Vector;
  screenX: number;
  screenY: number;
  screenRadius: number;
  depth: number;
  far: number;
  bright: number;
  fade: number;
  active: number;
  zoom: number;
  range: ClusterZoomRange;
  swapElapsedMs: number;
  /**
   * 只有三四张图：前后两面都画、按远近叠放。否则转到背面时整团只剩名称，
   * 暂停时还可能一直看不到图，也没有键盘与读屏入口。
   */
  sparse: boolean;
  label: Container;
  title: Text;
  count: Text;
  glow: Sprite;
};

const fieldOfViewTangent = Math.tan((50 * Math.PI) / 360);
const defaultDriftSpeed = 28;
const spinRate = 0.1;
const dragRate = 0.006;
const ringPeriodSeconds = 150;
// 一组星群刚出现时先完整展示这么久，自动播放才开始挑星团进入。
const overviewIntroSeconds = 4;
const leanLimit = 0.22;
const maximumVisibleItems = 96;
const reconcileIntervalMs = 200;
const wheelZoomRate = 0.0014;
const identity: Rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));
const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
const ease = (t: number) => t * t * (3 - 2 * t);
const damp = (elapsedSeconds: number, rate: number) => 1 - Math.exp(-elapsedSeconds * rate);

/** 把朝向 m 绕世界轴 axis 再转 angle 弧度（左乘）。 */
function rotate(m: Rotation, axis: Vector, angle: number): Rotation {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const r = [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c
  ];
  const result = new Array<number>(9);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      result[row * 3 + column] =
        r[row * 3]! * m[column]! + r[row * 3 + 1]! * m[3 + column]! + r[row * 3 + 2]! * m[6 + column]!;
    }
  }
  return result;
}

const turned = (m: Rotation, x: number, y: number, z: number): Vector => [
  m[0]! * x + m[1]! * y + m[2]! * z,
  m[3]! * x + m[4]! * y + m[5]! * z,
  m[6]! * x + m[7]! * y + m[8]! * z
];

function glowTexture(styles: CSSStyleDeclaration) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, styles.getPropertyValue("--public-color-ambient-glow-core").trim());
  gradient.addColorStop(0.35, styles.getPropertyValue("--public-color-ambient-glow-soft").trim());
  gradient.addColorStop(1, styles.getPropertyValue("--public-color-ambient-glow-clear").trim());
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  return Texture.from(canvas);
}

/**
 * 星群：每个分类是一个由图片铺成的星团，星团沿一条环排布。
 * 总览 → 进入星团（环绕浏览）→ 点击图片打开详情 → 缩回总览。
 * 图片卡片沿用 ShowPixiCard（边框、悬浮辉光与磁吸、贴图租约），场景只决定它们的位置、大小与显隐。
 */
export class ShowPixiClusterScene implements ShowPixiSceneController {
  readonly kind = "cluster" as const;
  readonly root = new Container();
  readonly #orbit = new Graphics();
  readonly #glows = new Container();
  readonly #cards = new Container();
  readonly #labels = new Container();
  readonly #glowTexture: Texture;
  readonly #labelColor: number;
  readonly #orbitColor: Color;
  readonly #perspectiveCoordinator = new ShowPixiPerspectiveCoordinator();
  readonly #textureCache: ShowPixiTextureCache;
  readonly #renderer: Renderer;
  readonly #element: HTMLElement;
  readonly #listeners = new AbortController();
  readonly #onOpen: (image: ShowImage, key: string) => void;
  readonly #onVisibleItems: (items: readonly ShowPixiVisibleItem[]) => void;
  readonly #onNeedClusterImages: ClusterSceneOptions["onNeedClusterImages"];
  readonly #onClusterFocusChange: (focus: ShowClusterFocus | null, automatic: boolean) => void;
  readonly #onManualVerticalMovement: (delta: number, pointerType?: string) => void;
  readonly #pointers = new Map<number, { x: number; y: number }>();
  #clusters: ClusterState[] = [];
  #dataKey = "";
  #width: number;
  #height: number;
  #focalLength = 1;
  #speedFactor: number;
  #running: boolean;
  #reducedMotion: boolean;
  #inputEnabled = true;
  #destroyed = false;
  // 相机：总览时正对原点；进入星团后注视该星团，成像倍数 zoom 负责群内缩放。
  #camera = { target: [0, 0, 0] as Vector, pitch: 0, distance: 2000, zoom: 1 };
  #wanted = { target: [0, 0, 0] as Vector, pitch: 0, distance: 2000, zoom: 1 };
  #zoomRate = 6;
  #basis = {
    origin: [0, 0, 0] as Vector,
    right: [1, 0, 0] as Vector,
    up: [0, 1, 0] as Vector,
    forward: [0, 0, -1] as Vector
  };
  #projected = { x: 0, y: 0, depth: 0, scale: 0 };
  // 星群环：横屏平放并向观看者倾斜，星团近大远小；竖屏正对屏幕竖立，星团都在同一平面上。
  #ring: ClusterRing = clusterRing(1, 2, 1);
  #ringOrder: ClusterState[] = [];
  #ringRotation: Rotation = identity;
  #ringPhase = 0;
  #ringPhaseGoal: number | null = null;
  #ringFling = 0;
  #ringLean = 0;
  #ringLine = 1;
  #narrow = false;
  #overviewDistance = 2000;
  #overviewZoom = 1;
  #overviewPull: ClusterState | null = null;
  #depthNear = 0;
  #depthSpan = 1;
  #activeCluster: ClusterState | null = null;
  #visitedKey = "";
  #cruiseSeconds = 0;
  #cruiseEntered = false;
  #drag: { x: number; y: number; startX: number; startY: number; moved: boolean } | null = null;
  #pinchDistance = 0;
  #reconcileElapsedMs = reconcileIntervalMs;
  #lastVisibleSignature: string | null = null;
  #focusedKey: string | null = null;
  #recycledCards = 0;
  #raisedCount = 0;

  constructor(options: ClusterSceneOptions) {
    this.#width = Math.max(1, options.width);
    this.#height = Math.max(1, options.height);
    this.#running = options.running;
    this.#reducedMotion = options.reducedMotion;
    this.#speedFactor = this.#factorFor(options.speed);
    this.#textureCache = options.textureCache;
    this.#renderer = options.renderer;
    this.#element = options.inputElement;
    const styles = getComputedStyle(this.#element);
    this.#glowTexture = glowTexture(styles);
    this.#labelColor = new Color(
      styles.getPropertyValue("--public-color-show-cluster-label").trim()
    ).toNumber();
    this.#orbitColor = new Color(
      styles.getPropertyValue("--public-color-show-cluster-orbit").trim()
    );
    this.#onOpen = options.onOpen;
    this.#onVisibleItems = options.onVisibleItems;
    this.#onNeedClusterImages = options.onNeedClusterImages;
    this.#onClusterFocusChange = options.onClusterFocusChange;
    this.#onManualVerticalMovement = options.onManualVerticalMovement;
    this.#cards.sortableChildren = true;
    this.#labels.eventMode = "none";
    this.#glows.eventMode = "none";
    this.root.addChild(this.#orbit, this.#glows, this.#cards, this.#labels);
    this.#bindInput();
    this.#focalLength = this.#height / 2 / fieldOfViewTangent;
    this.setClusters(options.clusters, options.dataKey);
  }

  // ---------- 数据 ----------

  setImages(_images: readonly ShowImage[], _dataKey: string, _order: ShowOrder, _hasMore: boolean) {
    // 星群不消费展映的单一图片流；它的数据经 setClusters 进入。
  }

  setClusters(clusters: readonly ShowCluster[], dataKey: string) {
    if (this.#destroyed) return;
    if (dataKey !== this.#dataKey || this.#clusters.length === 0) {
      this.#dataKey = dataKey;
      this.#exit(true, true);
      this.#clearClusters();
      this.#visitedKey = "";
      this.#overviewZoom = 1;
      this.#overviewPull = null;
      this.#ringFling = 0;
      this.#cruiseSeconds = -overviewIntroSeconds;
      this.#clusters = clusters
        .filter((cluster) => cluster.images.length > 0)
        .map((cluster) => this.#createCluster(cluster));
      this.#layoutRing(true);
      // 新的一组星群从远处推近，和页面初次进入时一致。
      this.#camera.distance = this.#overviewDistance * 1.9;
      return;
    }
    const incoming = new Map(clusters.map((cluster) => [cluster.key, cluster]));
    const removedClusters = this.#clusters.filter((cluster) => !incoming.has(cluster.key));
    if (removedClusters.length > 0) {
      this.#clearCardHover();
      if (this.#activeCluster && removedClusters.includes(this.#activeCluster)) this.#exit(true);
      if (this.#overviewPull && removedClusters.includes(this.#overviewPull)) this.#overviewPull = null;
      for (const cluster of removedClusters) this.#destroyCluster(cluster);
      this.#clusters = this.#clusters.filter((cluster) => incoming.has(cluster.key));
      this.#ringOrder = [];
      this.#layoutRing(false);
      this.#publishVisibleItems([]);
    }
    for (const state of this.#clusters) {
      const next = incoming.get(state.key);
      if (!next || next.images === state.images) continue;
      this.#lastVisibleSignature = null;
      // 续取或编辑后数组被替换：按最后消耗的图片重新定位队列，已上屏的卡片同步最新字段。
      const byId = new Map(next.images.map((image) => [image.id, image]));
      const at = next.images.findIndex((image) => image.id === state.lastConsumedId);
      const removed = next.total < state.total;
      state.images = next.images;
      state.next = at >= 0 ? at + 1 : Math.min(state.next, next.images.length);
      state.requested = false;
      if (next.total !== state.total) {
        state.total = next.total;
        state.count.text = `${next.total} 张`;
        if (state === this.#activeCluster)
          this.#onClusterFocusChange({ key: state.key, name: state.name, total: state.total }, true);
      }
      for (const slot of state.slots) {
        const updated = byId.get(slot.image.id);
        if (updated) {
          if (updated !== slot.image) this.#assignSlot(slot, updated);
        } else if (removed && !slot.vacant) {
          // 被删除的图片立即让位：有排队的图就换上，没有就空着。
          const replacement = state.images[state.next];
          if (replacement && !state.slots.some((other) => other.image.id === replacement.id)) {
            state.next += 1;
            state.lastConsumedId = replacement.id;
            this.#assignSlot(slot, replacement);
          } else {
            slot.vacant = true;
          }
        }
      }
    }
  }

  setSpeed(speed: number) {
    this.#speedFactor = this.#factorFor(speed);
  }

  #factorFor(speed: number) {
    return clamp((Number.isFinite(speed) ? speed : defaultDriftSpeed) / defaultDriftSpeed, 0.3, 2.5);
  }

  #createCluster(cluster: ShowCluster): ClusterState {
    const shown = Math.min(clusterShownCount(cluster.total), cluster.images.length);
    const images = cluster.images.slice(0, shown);
    const sphere = clusterSphereLayout(shown);
    const slots = sphere.points.map((point, index): SlotState => ({
      ...point,
      ...clusterCardSize(images[index]!),
      key: `${cluster.key}#${index}`,
      image: images[index]!,
      holder: null,
      card: null,
      alpha: 0,
      facing: 0,
      drawn: false,
      resident: false,
      interactive: false,
      raised: 0,
      engaged: false,
      vacant: false,
      screenWidth: 0,
      renderScale: 1,
      assignedScale: 1
    }));
    // 初始朝向：随机自转角加一点倾斜，各星团的自转轴不完全平行。
    let rotation = rotate(identity, [0, 1, 0], Math.random() * Math.PI * 2);
    rotation = rotate(rotation, [1, 0, 0], (Math.random() - 0.5) * 0.5);
    const label = new Container();
    const fontFamily = getComputedStyle(document.body).fontFamily;
    const name = new Text({
      text: cluster.name,
      style: { fontFamily, fontSize: 15, fontWeight: "600", fill: this.#labelColor, letterSpacing: 1 }
    });
    const count = new Text({
      text: `${cluster.total} 张`,
      style: { fontFamily, fontSize: 12, fill: this.#labelColor }
    });
    name.anchor.set(0.5, 0);
    count.anchor.set(0.5, 0);
    count.alpha = 0.6;
    count.y = 20;
    label.addChild(name, count);
    this.#labels.addChild(label);
    const glow = new Sprite(this.#glowTexture);
    glow.anchor.set(0.5);
    glow.blendMode = "add";
    this.#glows.addChild(glow);
    return {
      key: cluster.key,
      name: cluster.name,
      total: cluster.total,
      images: cluster.images,
      next: shown,
      lastConsumedId: images[shown - 1]?.id ?? "",
      requested: false,
      slots,
      radius: sphere.radius,
      overviewRadius: sphere.overviewRadius,
      rotation,
      axis: [rotation[1]!, rotation[4]!, rotation[7]!],
      fling: [0, 0],
      ringArc: 0,
      ringIndex: 0,
      position: [0, 0, 0],
      screenX: 0,
      screenY: 0,
      screenRadius: 0,
      depth: 0,
      far: 0,
      bright: 1,
      fade: 1,
      active: 0,
      zoom: 1,
      range: { fill: 1, entry: 1, exit: 0.5, maximum: 2 },
      swapElapsedMs: 0,
      sparse: slots.length <= 4,
      label,
      title: name,
      count,
      glow
    };
  }

  #clearClusters() {
    for (const cluster of this.#clusters) this.#destroyCluster(cluster);
    this.#clusters = [];
    this.#ringOrder = [];
    this.#orbit.clear();
    this.#publishVisibleItems([]);
  }

  #destroyCluster(cluster: ClusterState) {
    for (const slot of cluster.slots) this.#releaseSlot(slot);
    cluster.label.destroy({ children: true });
    cluster.glow.destroy();
  }

  #releaseSlot(slot: SlotState) {
    if (!slot.card || !slot.holder) return;
    slot.holder.parent?.removeChild(slot.holder);
    slot.card.destroy();
    slot.holder.destroy();
    slot.card = null;
    slot.holder = null;
    this.#recycledCards += 1;
  }

  /** 槽位换一张图：卡片面积不变，宽高改按新图的比例。 */
  #assignSlot(slot: SlotState, image: ShowImage) {
    slot.image = image;
    slot.vacant = false;
    Object.assign(slot, clusterCardSize(image));
    slot.card?.assign(
      slot.key,
      image,
      slot.width * slot.assignedScale,
      slot.height * slot.assignedScale,
      0,
      false,
      Math.max(1, slot.screenWidth)
    );
  }

  // ---------- 布局 ----------

  resize(width: number, height: number) {
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);
    this.#focalLength = this.#height / 2 / fieldOfViewTangent;
    this.#layoutRing(false);
    const cluster = this.#activeCluster;
    if (cluster) {
      cluster.range = this.#zoomRange(cluster);
      cluster.zoom = clamp(cluster.zoom, cluster.range.exit, cluster.range.maximum);
      this.#wanted.distance = this.#fitDistance(cluster);
      this.#wanted.zoom = cluster.zoom * cluster.range.fill;
    }
  }

  /** 总览里星团占据的半径：球面加上探出去的半张卡片。 */
  #footprint(cluster: ClusterState) {
    return cluster.overviewRadius + clusterCardSide * 0.7;
  }

  #layoutRing(immediate: boolean) {
    if (this.#clusters.length === 0) return;
    const narrow = this.#width < this.#height * 0.9;
    if (narrow !== this.#narrow) this.#ringLean = 0;
    this.#narrow = narrow;
    this.#orientRing();
    // 大小交错地排在环上，避免大星团挤在一侧。
    const sorted = [...this.#clusters].sort(
      (left, right) => right.overviewRadius - left.overviewRadius
    );
    const order: ClusterState[] = [];
    while (sorted.length > 0) {
      order.push(sorted.shift()!);
      if (sorted.length > 0) order.push(sorted.pop()!);
    }
    const arcs = order.map((cluster) => 2 * this.#footprint(cluster) + 50);
    const total = arcs.reduce((sum, arc) => sum + arc, 0);
    const largest = Math.max(...order.map((cluster) => this.#footprint(cluster)));
    const safeRatio = narrow
      ? (this.#height / 2 - 96) / (this.#width / 2 - 20)
      : (this.#width / 2 - 20) / (this.#height / 2 - 96);
    this.#ring = clusterRing(
      total * 1.06,
      clamp(safeRatio * 0.95, narrow ? 1.2 : 1.6, 2.8),
      largest * (narrow ? 1.3 : 1.7)
    );
    this.#ringOrder = order;
    let cursor = 0;
    order.forEach((cluster, index) => {
      cluster.ringArc = ((cursor + arcs[index]! / 2) / total) * this.#ring.length;
      cluster.ringIndex = index;
      cursor += arcs[index]!;
    });
    for (const cluster of this.#clusters) cluster.position = this.#ringPosition(cluster);
    if (immediate) this.#overviewDistance = this.#ringFitDistance();
  }

  #orientRing() {
    this.#ringRotation = this.#narrow
      // 竖屏：环的长轴朝上、短轴朝右，整条环正对屏幕。
      ? [0, 0, 1, 1, 0, 0, 0, 1, 0]
      : rotate(identity, [1, 0, 0], 0.6 + this.#ringLean);
  }

  #ringPosition(cluster: ClusterState): Vector {
    // 只有一个星团时没有“环”可言：它就在画面正中，不绕着空环公转。
    if (this.#clusters.length === 1) return [0, 0, 0];
    const point = clusterRingPoint(this.#ring, cluster.ringArc + this.#ringPhase);
    return turned(this.#ringRotation, point.u, 0, point.v);
  }

  /** 星团转到这里时处在屏幕中间靠下的位置：横屏是环的最前端，竖屏是环的最低点。 */
  #focusArc() {
    return clusterRingQuarterArc(this.#ring, this.#narrow ? 2 : 1);
  }

  #ringFitDistance() {
    const halfWidth = Math.max(1, this.#width / 2 - 20);
    const halfHeight = Math.max(1, this.#height / 2 - 88);
    let distance = 1;
    for (const cluster of this.#clusters) {
      const [x, y, z] = cluster.position;
      const radius = this.#footprint(cluster);
      distance = Math.max(
        distance,
        z + ((Math.abs(x) + radius) * this.#focalLength) / halfWidth,
        z + ((Math.abs(y) + radius) * this.#focalLength) / halfHeight
      );
    }
    return distance;
  }

  #fitDistance(cluster: ClusterState) {
    const radius = cluster.radius * clusterExpand + clusterCardSide;
    return (radius / (fieldOfViewTangent * Math.min(1, this.#width / this.#height))) * 1.06;
  }

  #zoomRange(cluster: ClusterState) {
    return clusterZoomRange({
      width: this.#width,
      height: this.#height,
      focalLength: this.#focalLength,
      radius: cluster.radius * clusterExpand,
      distance: this.#fitDistance(cluster)
    });
  }

  // ---------- 状态切换 ----------

  command(command: ShowClusterCommand) {
    if (this.#destroyed || this.#clusters.length === 0) return;
    this.#touchCruise();
    const cluster = this.#activeCluster;
    if (command.type === "exit") {
      this.#exit(true);
    } else if (command.type === "step") {
      // 上一个 / 下一个星团：沿环的公转方向依次切换。
      const current =
        cluster ?? this.#clusters.find((candidate) => candidate.key === this.#visitedKey);
      const next = current ? this.#ringNeighbour(current, command.direction) : this.#frontCluster();
      if (next) this.#enter(next, false);
    } else if (cluster) {
      // 群内按一格缩放，缩到底回到总览。
      this.#zoomCluster(cluster, command.direction > 0 ? 1 / 1.25 : 1.25);
    } else if (command.direction > 0) {
      // 总览里放大即进入最靠近屏幕中间的星团。
      const front = this.#frontCluster();
      if (front) this.#enter(front, false);
    }
  }

  #enter(cluster: ClusterState, automatic: boolean) {
    if (this.#activeCluster === cluster) return;
    this.#activeCluster = cluster;
    this.#visitedKey = cluster.key;
    this.#overviewZoom = 1;
    this.#overviewPull = null;
    cluster.range = this.#zoomRange(cluster);
    cluster.zoom = cluster.range.entry;
    cluster.fling = [0, 0];
    // 进入时环不动。等其余星团隐去后，再把环换到“当前星团在屏幕中间”的位置（见 #stepRing）。
    const goal = this.#focusArc() - cluster.ringArc;
    this.#ringPhaseGoal =
      goal + this.#ring.length * Math.round((this.#ringPhase - goal) / this.#ring.length);
    this.#wanted.distance = this.#fitDistance(cluster);
    this.#wanted.pitch = this.#narrow ? 0 : 0.1;
    this.#wanted.zoom = cluster.zoom * cluster.range.fill;
    this.#zoomRate = 2.6;
    this.#cruiseSeconds = 0;
    this.#cruiseEntered = automatic;
    this.#lastVisibleSignature = null;
    this.#onClusterFocusChange(
      { key: cluster.key, name: cluster.name, total: cluster.total },
      automatic
    );
  }

  #exit(notify: boolean, automatic = false) {
    if (!this.#activeCluster) return;
    this.#activeCluster = null;
    this.#ringPhaseGoal = null;
    this.#overviewZoom = 1;
    this.#wanted.zoom = 1;
    this.#wanted.pitch = 0;
    this.#zoomRate = 2.6;
    // 访客自己退出时保留刚得到的暂缓，不立刻被自动播放带进下一个星团。
    this.#cruiseSeconds = Math.min(this.#cruiseSeconds, 0);
    this.#clearCardHover();
    this.#publishVisibleItems([]);
    if (notify) this.#onClusterFocusChange(null, automatic);
  }

  #ringNeighbour(cluster: ClusterState, direction: number) {
    const count = this.#ringOrder.length;
    // 环公转时序号小一位的星团接着转过来，所以“下一个”取序号减一。
    return this.#ringOrder[(((cluster.ringIndex - direction) % count) + count) % count];
  }

  /** 环上“屏幕中间靠前”那一点：自动播放进入、相邻切换的起点与贴图加载的先后都以它为准。 */
  #frontPoint(): Vector {
    const point = clusterRingPoint(this.#ring, this.#focusArc());
    return turned(this.#ringRotation, point.u, 0, point.v);
  }

  /** 离“屏幕中间靠前”那一点最近的星团。 */
  #frontCluster() {
    const [x, y, z] = this.#frontPoint();
    let best: ClusterState | undefined;
    let bestDistance = Infinity;
    for (const cluster of this.#clusters) {
      const distance = Math.hypot(
        cluster.position[0] - x,
        cluster.position[1] - y,
        cluster.position[2] - z
      );
      if (distance < bestDistance) {
        best = cluster;
        bestDistance = distance;
      }
    }
    return best;
  }

  // ---------- 逐帧 ----------

  update(elapsedMs: number) {
    if (this.#destroyed || this.#clusters.length === 0) return;
    const elapsed = Math.min(48, Math.max(0, elapsedMs)) / 1000;
    const moving = this.#running && !this.#reducedMotion && this.#pointers.size === 0;
    this.#stepCruise(elapsed, moving);
    this.#stepRing(elapsed, moving);
    this.#stepCamera(elapsed);
    this.#computeBasis();
    this.#drawOrbit(elapsed);
    for (const cluster of this.#clusters) this.#stepCluster(cluster, elapsed, moving);
    this.#reconcileElapsedMs += elapsedMs;
    if (this.#reconcileElapsedMs >= reconcileIntervalMs) {
      this.#reconcileElapsedMs = 0;
      this.#reconcile();
    }
  }

  #stepCruise(elapsed: number, moving: boolean) {
    if (!moving) return;
    this.#cruiseSeconds += elapsed;
    const cluster = this.#activeCluster;
    if (cluster) {
      // 自动进入的星团停留一段时间后回到总览；访客自己进入或操作过的一直停留。
      if (this.#cruiseEntered && this.#cruiseSeconds > this.#dwellSeconds(cluster)) {
        this.#exit(true, true);
      }
      return;
    }
    // 环在公转：哪个星团转到屏幕中间就放大哪个；刚看过的那个还停在中间，等下一个转过来。
    if (this.#cruiseSeconds < 1.2) return;
    const front = this.#frontCluster();
    if (!front) return;
    if (this.#clusters.length === 1) {
      if (this.#cruiseSeconds > 5.5) this.#enter(front, true);
      return;
    }
    const focus = this.#frontPoint();
    if (!this.#project(focus[0], focus[1], focus[2])) return;
    const offset =
      Math.hypot(front.screenX - this.#projected.x, front.screenY - this.#projected.y) /
      Math.min(this.#width, this.#height);
    if (offset < 0.1 && front.key !== this.#visitedKey) this.#enter(front, true);
  }

  /** 自动进入的星团停留多久：图多的多看一会儿，图少的早些让位；播放速度调快时相应缩短。 */
  #dwellSeconds(cluster: ClusterState) {
    return clamp(8 + (cluster.slots.length - 8) * 0.2, 8, 30) / this.#speedFactor;
  }

  #stepRing(elapsed: number, moving: boolean) {
    let nearest = Infinity;
    let farthest = -Infinity;
    for (const cluster of this.#clusters) {
      nearest = Math.min(nearest, cluster.depth);
      farthest = Math.max(farthest, cluster.depth);
    }
    this.#depthNear = nearest;
    this.#depthSpan = Math.max(farthest - nearest, this.#ring.minor * 0.6);
    const active = this.#activeCluster;
    if (active) {
      if (
        this.#ringPhaseGoal !== null &&
        this.#clusters.every((cluster) => cluster === active || cluster.fade < 0.02)
      ) {
        // 其余星团都看不见了：一次性换位，镜头平移同样的距离，当前星团在画面上不动。
        const before = active.position;
        this.#ringPhase = this.#ringPhaseGoal;
        this.#ringPhaseGoal = null;
        active.position = this.#ringPosition(active);
        for (let axis = 0; axis < 3; axis += 1) {
          this.#camera.target[axis]! += active.position[axis]! - before[axis]!;
        }
      }
      return;
    }
    if (moving) this.#ringPhase += (this.#ring.length / ringPeriodSeconds) * this.#speedFactor * elapsed;
    if (this.#pointers.size === 0 && Math.abs(this.#ringFling) > 0.05) {
      // 惯性以“每 1/60 秒的位移”计，按实际帧长折算，高刷新率下不会转得更快。
      this.#ringPhase += this.#ringFling * elapsed * 60;
      this.#ringFling *= Math.exp(-elapsed * 3.5);
    }
    this.#overviewDistance += (this.#ringFitDistance() - this.#overviewDistance) * damp(elapsed, 2.5);
  }

  #stepCamera(elapsed: number) {
    const active = this.#activeCluster;
    if (active) {
      this.#wanted.target = active.position;
    } else {
      const pull = this.#overviewPull ? clamp((1 - this.#overviewZoom) / 0.4, 0, 1) * 0.75 : 0;
      const towards = this.#overviewPull?.position ?? [0, 0, 0];
      this.#wanted.target = [towards[0] * pull, towards[1] * pull, towards[2] * pull];
      this.#wanted.distance = this.#overviewDistance * this.#overviewZoom;
    }
    const follow = damp(elapsed, 3);
    for (let axis = 0; axis < 3; axis += 1) {
      this.#camera.target[axis]! += (this.#wanted.target[axis]! - this.#camera.target[axis]!) * follow;
    }
    this.#camera.pitch += (this.#wanted.pitch - this.#camera.pitch) * follow;
    this.#camera.distance += (this.#wanted.distance - this.#camera.distance) * follow;
    this.#camera.zoom += (this.#wanted.zoom - this.#camera.zoom) * damp(elapsed, this.#zoomRate);
  }

  #computeBasis() {
    const cosine = Math.cos(this.#camera.pitch);
    const sine = Math.sin(this.#camera.pitch);
    const forward: Vector = [0, -sine, -cosine];
    this.#basis.forward = forward;
    this.#basis.right = [1, 0, 0];
    this.#basis.up = [0, cosine, -sine];
    this.#basis.origin = [
      this.#camera.target[0] - forward[0] * this.#camera.distance,
      this.#camera.target[1] - forward[1] * this.#camera.distance,
      this.#camera.target[2] - forward[2] * this.#camera.distance
    ];
  }

  #project(x: number, y: number, z: number) {
    const { origin, right, up, forward } = this.#basis;
    const dx = x - origin[0];
    const dy = y - origin[1];
    const dz = z - origin[2];
    const depth = dx * forward[0] + dy * forward[1] + dz * forward[2];
    if (depth < 8) return false;
    const scale = (this.#focalLength * this.#camera.zoom) / depth;
    this.#projected.x = this.#width / 2 + (dx * right[0] + dy * right[1] + dz * right[2]) * scale;
    this.#projected.y = this.#height / 2 - (dx * up[0] + dy * up[1] + dz * up[2]) * scale;
    this.#projected.depth = depth;
    this.#projected.scale = scale;
    return true;
  }

  #drawOrbit(elapsed: number) {
    this.#ringLine += ((this.#activeCluster ? 0 : 1) - this.#ringLine) * damp(elapsed, 4);
    this.#orbit.clear();
    if (this.#ringLine < 0.02 || this.#clusters.length < 2) return;
    let started = false;
    for (let step = 0; step < this.#ring.table.length; step += 4) {
      const point = this.#ring.table[step]!;
      const [x, y, z] = turned(this.#ringRotation, point.u, 0, point.v);
      if (!this.#project(x, y, z)) {
        started = false;
        continue;
      }
      if (started) this.#orbit.lineTo(this.#projected.x, this.#projected.y);
      else this.#orbit.moveTo(this.#projected.x, this.#projected.y);
      started = true;
    }
    this.#orbit.stroke({
      width: 1,
      color: this.#orbitColor.toNumber(),
      alpha: this.#orbitColor.alpha * this.#ringLine
    });
  }

  #stepCluster(cluster: ClusterState, elapsed: number, moving: boolean) {
    const focus = this.#activeCluster;
    const active = focus === cluster;
    cluster.position = this.#ringPosition(cluster);
    cluster.active += ((active ? 1 : 0) - cluster.active) * damp(elapsed, 3.2);
    // 总览里环的远侧略暗；群内浏览时其余星团压暗作背景。
    cluster.far = clamp((cluster.depth - this.#depthNear) / this.#depthSpan, 0, 1);
    const bright = focus ? (active ? 1 : 0.18) : 1 - 0.4 * cluster.far;
    cluster.bright += (bright - cluster.bright) * damp(elapsed, 3);
    // 挡在当前星团前面的整体淡出；其余的随“从进入大小往外缩”渐渐回到背景，缩到短边填满时完全显现。
    let fade = 1;
    if (focus && !active) {
      // 竖屏的星团都在同一平面上，谁也不挡谁。
      const blocking =
        !this.#narrow && cluster.depth < focus.depth + focus.radius * clusterExpand;
      const pulledBack =
        (focus.range.entry - this.#camera.zoom / focus.range.fill) /
        Math.max(0.05, focus.range.entry - focus.range.exit);
      fade = blocking ? 0 : clamp(pulledBack, 0, 1);
    }
    cluster.fade += (fade - cluster.fade) * damp(elapsed, 5);

    if (moving) {
      this.#rotateImages(cluster, active, elapsed);
      cluster.rotation = rotate(
        cluster.rotation,
        cluster.axis,
        spinRate * this.#speedFactor * (active ? 0.6 : 1) * elapsed
      );
    }
    if (this.#pointers.size === 0 && Math.hypot(cluster.fling[0], cluster.fling[1]) > 0.0004) {
      const frames = elapsed * 60;
      cluster.rotation = rotate(
        rotate(cluster.rotation, this.#basis.right, cluster.fling[1] * frames),
        this.#basis.up,
        cluster.fling[0] * frames
      );
      const decay = Math.exp(-elapsed * 3.5);
      cluster.fling[0] *= decay;
      cluster.fling[1] *= decay;
    }

    const e = ease(clamp(cluster.active, 0, 1));
    // 进入后球面展开、卡片放大，图片之间拉开距离。
    const radius = lerp(cluster.overviewRadius, cluster.radius * clusterExpand, e);
    const growth = lerp(1, clusterCardGrowth, e);
    const [cx, cy, cz] = cluster.position;
    if (!this.#project(cx, cy, cz)) {
      // 星团中心到了镜头平面之后：整团不画，也不沿用上一次投影的位置与远近。
      cluster.screenRadius = 0;
      cluster.depth = 0;
      cluster.glow.visible = false;
      cluster.label.visible = false;
      for (const slot of cluster.slots) {
        slot.alpha = 0;
        slot.drawn = false;
        slot.resident = false;
        if (slot.holder) slot.holder.visible = false;
      }
      return;
    }
    cluster.screenX = this.#projected.x;
    cluster.screenY = this.#projected.y;
    cluster.depth = this.#projected.depth;
    cluster.screenRadius = radius * this.#projected.scale;

    cluster.glow.visible = cluster.fade > 0.02;
    if (cluster.glow.visible) {
      cluster.glow.position.set(cluster.screenX, cluster.screenY);
      cluster.glow.width = cluster.glow.height = cluster.screenRadius * 3.1;
      // 进入星团后光晕铺满整个画面，只留一点点，不把背景整体照亮。
      cluster.glow.alpha = lerp(0.5, 0.12, e) * cluster.bright * cluster.fade;
    }
    const labelVisible = !focus && this.#labelUncovered(cluster);
    cluster.label.visible = labelVisible;
    if (labelVisible) this.#placeLabel(cluster);

    // 只画朝向观看者的一面：背面的图片本来就被挡住大半，不画也就不请求；换图发生在隐去的部分。
    // 总览里星团小，过了轮廓一点才隐去，边缘显得圆润；进入后收到轮廓以内。
    const sparse = cluster.sparse;
    const fadeFrom = lerp(-0.1, 0.02, e);
    const fadeTo = lerp(0.25, 0.2, e);
    const m = cluster.rotation;
    const origin = this.#basis.origin;
    // 叠放次序按“绕自转轴转到了哪里”定，而不是按远近：自转时所有卡片的这个角度同步前进，
    // 相互重叠的两张图谁在上面不变，不会在转动中突然翻到前面。次序的接缝在背离观看者的一侧；
    // 自转轴朝观看者倾斜时，靠近轴端的个别卡片会在接缝处换一次次序。
    const [ax, ay, az] = cluster.axis;
    const vx = origin[0] - cx;
    const vy = origin[1] - cy;
    const vz = origin[2] - cz;
    const along = vx * ax + vy * ay + vz * az;
    const fx = vx - along * ax;
    const fy = vy - along * ay;
    const fz = vz - along * az;
    const sx = ay * fz - az * fy;
    const sy = az * fx - ax * fz;
    const sz = ax * fy - ay * fx;
    for (const slot of cluster.slots) {
      const [dx, dy, dz] = slot.direction;
      // 总览里卡片有深有浅；展开后收拢到接近同一层球面，减少互相遮挡。
      const reach = lerp(slot.reach, 0.9 + (slot.reach - 0.7) / 3, e) * radius;
      const px = (m[0]! * dx + m[1]! * dy + m[2]! * dz) * reach;
      const py = (m[3]! * dx + m[4]! * dy + m[5]! * dz) * reach;
      const pz = (m[6]! * dx + m[7]! * dy + m[8]! * dz) * reach;
      if (slot.vacant || cluster.fade < 0.02 || !this.#project(cx + px, cy + py, cz + pz)) {
        slot.alpha = 0;
        slot.drawn = false;
        slot.resident = false;
        slot.raised = 0;
        slot.engaged = false;
        if (slot.holder) slot.holder.visible = false;
        continue;
      }
      // 朝向：球面外法线与“指向相机”方向的夹角余弦，1 = 正对观看者，0 = 恰在轮廓上。
      // 按朝向而不是远近渐隐：卡片只从轮廓外缘进入，向内移动时逐渐显现。
      const tx = origin[0] - cx - px;
      const ty = origin[1] - cy - py;
      const tz = origin[2] - cz - pz;
      const facing =
        (px * tx + py * ty + pz * tz) /
        ((Math.hypot(px, py, pz) || 1) * Math.hypot(tx, ty, tz));
      slot.facing = facing;
      const base = sparse ? 1 : ease(clamp((facing - fadeFrom) / (fadeTo - fadeFrom), 0, 1));
      const scale = this.#projected.scale * growth;
      const width = slot.width * scale;
      const height = slot.height * scale;
      const x = this.#projected.x;
      const y = this.#projected.y;
      // 总览之外的位置随进入星团渐渐出现；在那之前不画，也就不请求它们的图片。
      slot.alpha = base * cluster.fade * (slot.overview ? 1 : e);
      // 卡片按接近屏幕像素的尺寸绘制，外层只做不到一成的缩放：悬浮时的快照与屏幕等清晰度，
      // 边框与圆角也不必每帧重画。
      // 倍数设下限：卡片最小只画到 1 像素，再小就和外层缩放对不上了。
      slot.renderScale = Math.max(0.1, 2 ** (Math.round(Math.log2(scale) * 4) / 4));
      slot.screenWidth = width;
      const shown = slot.alpha > 0.01;
      slot.drawn =
        shown &&
        x + width > 0 &&
        x - width < this.#width &&
        y + height > 0 &&
        y - height < this.#height;
      // 视口外半屏以内的卡片先备好贴图：转动或缩小时进入画面的是图片，而不是占位色块。
      slot.resident =
        shown &&
        x + width > -this.#width / 2 &&
        x - width < this.#width * 1.5 &&
        y + height > -this.#height / 2 &&
        y - height < this.#height * 1.5;
      if (!slot.drawn || !active) {
        slot.raised = 0;
        slot.engaged = false;
      }
      const holder = slot.holder;
      if (!holder || !slot.card) continue;
      holder.visible = slot.drawn;
      if (!slot.drawn) continue;
      // 与漂浮画面一致：悬浮或聚焦过的卡片在指针离开后留在最上层，后看的叠在先看的之上。
      const engaged = slot.card.isInteractionActive;
      // 前后两面都画的星团按远近叠放，不留置顶：卡片不会转出画面，置顶就一直压着别的图。
      if (engaged && active && !slot.engaged && !sparse) slot.raised = ++this.#raisedCount;
      slot.engaged = engaged && active;
      const level = lerp(lerp(0.45, 1, clamp((facing + 0.6) / 1.2, 0, 1)), 1, e) * cluster.bright;
      const gray = Math.round(255 * clamp(level, 0, 1));
      holder.position.set(x, y);
      holder.scale.set(scale / slot.assignedScale);
      holder.alpha = slot.card.isInteractionActive ? cluster.fade : slot.alpha;
      holder.tint = slot.card.isInteractionActive ? 0xffffff : (gray << 16) | (gray << 8) | gray;
      holder.zIndex = engaged
        ? 1_000_000_000
        : slot.raised > 0
          ? 1_000 + slot.raised
          : sparse
            ? // 前后两面都画时按远近叠放，近的在上。
              -this.#projected.depth
            : Math.atan2(px * sx + py * sy + pz * sz, px * fx + py * fy + pz * fz) - cluster.depth;
      // 只有已基本显现的卡片可以悬浮与点击；总览里点击的是整个星团。
      const interactive = this.#inputEnabled && active && base >= 0.8;
      if (interactive !== slot.interactive) {
        slot.interactive = interactive;
        slot.card.setInteractionEnabled(interactive);
      }
      slot.card.update(elapsed * 1000);
    }
  }

  #placeLabel(cluster: ClusterState) {
    const reach = cluster.screenRadius * 0.96 + 8;
    let anchor = 0.5;
    let scale = 1;
    let x = cluster.screenX;
    let y = cluster.screenY + reach;
    if (this.#narrow && this.#project(0, 0, 0)) {
      // 竖屏的环正对屏幕，上下相邻的星团挨得近：名称放到环的内侧，并收在环心这一侧的宽度之内。
      const dx = this.#projected.x - cluster.screenX;
      const dy = this.#projected.y - cluster.screenY;
      const length = Math.hypot(dx, dy) || 1;
      anchor = dx / length > 0.35 ? 0 : dx / length < -0.35 ? 1 : 0.5;
      if (anchor !== 0.5) {
        const width = Math.max(cluster.title.width, cluster.count.width, 1);
        scale = clamp((Math.abs(dx) - reach - 4) / width, 0.5, 1);
      }
      const height = (cluster.count.y + cluster.count.height) * scale;
      x = cluster.screenX + (dx / length) * reach;
      y =
        cluster.screenY +
        (dy / length) * reach -
        (anchor !== 0.5 ? height / 2 : dy < 0 ? height : 0);
    }
    cluster.title.anchor.x = anchor;
    cluster.count.anchor.x = anchor;
    cluster.label.scale.set(scale);
    cluster.label.position.set(x, y);
    cluster.label.alpha = 1 - 0.45 * cluster.far;
  }

  /** 名称被更近的星团挡住时不显示。 */
  #labelUncovered(cluster: ClusterState) {
    const x = cluster.screenX;
    const y = cluster.screenY + cluster.screenRadius * 0.96 + 24;
    return !this.#clusters.some(
      (other) =>
        other !== cluster &&
        other.depth < cluster.depth &&
        Math.hypot(x - other.screenX, y - other.screenY) < other.screenRadius * 0.95
    );
  }

  /** 轮换：只给完全没画出来的槽位换图（转到背面或在视口之外），画面上看不到切换。 */
  #rotateImages(cluster: ClusterState, active: boolean, elapsed: number) {
    const remaining = cluster.images.length - cluster.next;
    if (remaining < 24 && !cluster.requested && cluster.total > cluster.slots.length) {
      cluster.requested = true;
      this.#onNeedClusterImages(
        cluster.key,
        cluster.slots.filter((slot) => !slot.vacant).map((slot) => slot.image.id)
      );
    }
    if (remaining <= 0) return;
    cluster.swapElapsedMs += elapsed * 1000;
    // 总览里星团很小，慢慢换即可，也只换总览会画出来的位置。
    if (cluster.swapElapsedMs < (active ? 500 : 6000)) return;
    const hidden = cluster.slots.filter((slot) => !slot.drawn && (active || slot.overview));
    if (hidden.length === 0) return;
    cluster.swapElapsedMs = 0;
    const image = cluster.images[cluster.next]!;
    cluster.next += 1;
    cluster.lastConsumedId = image.id;
    // 一轮走完后从头再来时，队首可能还在屏幕上：跳过，不让同一张图同时出现两次。
    if (cluster.slots.some((slot) => slot.image.id === image.id)) return;
    this.#assignSlot(hidden[Math.floor(Math.random() * hidden.length)]!, image);
  }

  /** 低频协调：按需创建 / 回收卡片、分配贴图档位、发布键盘与读屏代理。 */
  #reconcile() {
    // 贴图按卡片创建的先后排队：当前星团最先，其余从屏幕中间靠前的星团往两边、再往后。
    const front = this.#frontPoint();
    const distance = (cluster: ClusterState) =>
      cluster === this.#activeCluster
        ? -1
        : Math.hypot(
            cluster.position[0] - front[0],
            cluster.position[1] - front[1],
            cluster.position[2] - front[2]
          );
    const drawn: SlotState[] = [];
    for (const cluster of [...this.#clusters].sort((left, right) => distance(left) - distance(right))) {
      for (const slot of cluster.slots) {
        if (slot.resident) drawn.push(slot);
        // 看不见的槽位不持有卡片与贴图租约；转回来时重新创建。
        else if (slot.card && !slot.card.isInteractionActive) this.#releaseSlot(slot);
      }
    }
    const lods = this.#textureCache.fitResidentLods(
      drawn.map((slot) => ({
        url: imageVariantUrl(slot.image, "small"),
        lod: showPixiTextureLod(slot.image, Math.max(1, slot.screenWidth), slot.height / slot.width)
      }))
    );
    for (const [index, slot] of drawn.entries()) {
      if (!slot.card) {
        const holder = new Container();
        const card = new ShowPixiCard(
          this.#textureCache,
          this.#onOpen,
          this.#renderer,
          this.#perspectiveCoordinator
        );
        holder.addChild(card.root);
        holder.visible = false;
        this.#cards.addChild(holder);
        slot.holder = holder;
        slot.card = card;
        card.setVisible(true);
        card.setPerspectiveEnabled(true);
        card.setInteractionEnabled(false);
        slot.interactive = false;
      }
      const resized = slot.assignedScale !== slot.renderScale;
      if (resized) {
        // 卡片换一档尺寸重画，外层缩放在同一帧里反向补上，屏幕上的大小不跳。
        slot.holder!.scale.set((slot.holder!.scale.x * slot.assignedScale) / slot.renderScale);
        slot.assignedScale = slot.renderScale;
      }
      slot.card.assign(
        slot.key,
        slot.image,
        slot.width * slot.assignedScale,
        slot.height * slot.assignedScale,
        0,
        false,
        Math.max(1, slot.screenWidth),
        1,
        lods[index]
      );
      // assign 在图片或键变化时会清掉焦点，这里按键盘代理的当前焦点补回。
      slot.card.setFocused(slot.key === this.#focusedKey);
      // 悬浮中的卡片显示的是倾斜快照：尺寸换档后在同一帧里按新尺寸重算，否则会闪一下。
      if (resized && slot.card.isInteractionActive) slot.card.update(0);
    }
    const active = this.#activeCluster;
    const items: ShowPixiVisibleItem[] = [];
    if (active) {
      for (const slot of active.slots) {
        if (items.length >= maximumVisibleItems) break;
        if (slot.drawn && (active.sparse || slot.facing > 0.4)) {
          items.push({ key: slot.key, image: slot.image });
        }
      }
    }
    this.#publishVisibleItems(items);
  }

  #publishVisibleItems(items: readonly ShowPixiVisibleItem[]) {
    const signature = items.map((item) => `${item.key}:${item.image.id}`).join("|");
    if (signature === this.#lastVisibleSignature) return;
    this.#lastVisibleSignature = signature;
    this.#onVisibleItems(items);
  }

  // ---------- 输入 ----------

  setInputEnabled(enabled: boolean) {
    this.#inputEnabled = enabled;
    if (!enabled) {
      this.#pointers.clear();
      this.#drag = null;
      this.#clearCardHover();
    }
  }

  setMotion(running: boolean, reducedMotion: boolean) {
    this.#running = running;
    this.#reducedMotion = reducedMotion;
  }

  focusCard(key: string | null) {
    this.#focusedKey = key;
    for (const cluster of this.#clusters) {
      for (const slot of cluster.slots) slot.card?.setFocused(slot.key === key);
    }
  }

  clearPointerHover() {
    this.#clearCardHover();
  }

  #clearCardHover() {
    for (const cluster of this.#clusters) {
      for (const slot of cluster.slots) slot.card?.clearPointerHover();
    }
  }

  #bindInput() {
    const { signal } = this.#listeners;
    const element = this.#element;
    const local = (event: PointerEvent | WheelEvent) => {
      const bounds = element.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };
    element.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.#inputEnabled || (event.pointerType === "mouse" && event.button !== 0)) return;
        const point = local(event);
        this.#pointers.set(event.pointerId, point);
        this.#touchCruise();
        if (this.#pointers.size === 1) {
          this.#drag = { ...point, startX: point.x, startY: point.y, moved: false };
          this.#ringFling = 0;
          if (this.#activeCluster) this.#activeCluster.fling = [0, 0];
        } else {
          this.#drag = null;
          const [first, second] = [...this.#pointers.values()];
          this.#pinchDistance = Math.hypot(first!.x - second!.x, first!.y - second!.y);
          this.#clearCardHover();
        }
      },
      { signal }
    );
    element.addEventListener(
      "pointermove",
      (event) => {
        const pointer = this.#pointers.get(event.pointerId);
        if (!pointer || !this.#inputEnabled) return;
        if (event.pointerType === "mouse" && event.buttons === 0) {
          // 鼠标在画布之外松开时收不到 pointerup：回到画布上发现按键已松开，就此结束这次按下。
          this.#pointers.delete(event.pointerId);
          this.#pinchDistance = 0;
          this.#drag = null;
          return;
        }
        const point = local(event);
        const dx = point.x - pointer.x;
        const dy = point.y - pointer.y;
        pointer.x = point.x;
        pointer.y = point.y;
        if (this.#pointers.size === 2) {
          const [first, second] = [...this.#pointers.values()];
          const distance = Math.hypot(first!.x - second!.x, first!.y - second!.y);
          if (this.#pinchDistance > 0 && distance > 0) {
            this.#zoom(
              this.#pinchDistance / distance,
              (first!.x + second!.x) / 2,
              (first!.y + second!.y) / 2,
              event.pointerType
            );
          }
          this.#pinchDistance = distance;
          return;
        }
        const drag = this.#drag;
        if (!drag) return;
        if (!drag.moved && Math.hypot(point.x - drag.startX, point.y - drag.startY) < 6) return;
        if (!drag.moved) {
          drag.moved = true;
          // 开始拖动后，这次按下不再算作点击卡片。
          element.setPointerCapture(event.pointerId);
        }
        // 与其他展映画面一致：向下拖动唤出导航，向上拖动收起。
        this.#onManualVerticalMovement(-dy, event.pointerType);
        const cluster = this.#activeCluster;
        if (cluster) {
          // 绕屏幕的竖直轴与水平轴转动星团本身，四个方向都可以一直转；放大后转得慢一些。
          const rate = dragRate / Math.max(1, this.#camera.zoom);
          cluster.fling = [clamp(dx * rate, -0.08, 0.08), clamp(dy * rate, -0.08, 0.08)];
          cluster.rotation = rotate(
            rotate(cluster.rotation, this.#basis.right, cluster.fling[1]),
            this.#basis.up,
            cluster.fling[0]
          );
          return;
        }
        this.#ringPhaseGoal = null;
        // 一个像素的拖动对应环上多长的一段：按环上离观看者最近处的成像比例折算。
        const depth = this.#overviewDistance - (this.#narrow ? 0 : this.#ring.minor * 0.8);
        const perPixel = Math.max(0.5, depth / this.#focalLength);
        if (this.#narrow) {
          // 竖屏的环正对屏幕：沿切线方向拖动带动公转。
          const rx = point.x - this.#width / 2;
          const ry = point.y - this.#height / 2;
          const tangent = (rx * dy - ry * dx) / Math.max(1, Math.hypot(rx, ry));
          this.#ringFling = clamp(tangent * perPixel, -45, 45);
        } else {
          // 横屏的环只绕自己的轴转：左右拖动公转，上下拖动只微调倾角。
          this.#ringLean = clamp(this.#ringLean + dy * 0.0025, -leanLimit, leanLimit);
          this.#orientRing();
          this.#ringFling = clamp(-dx * perPixel, -45, 45);
        }
        this.#ringPhase += this.#ringFling;
      },
      { signal }
    );
    const release = (event: PointerEvent) => {
      if (!this.#pointers.delete(event.pointerId)) return;
      this.#pinchDistance = 0;
      const drag = this.#drag;
      this.#drag = null;
      if (!drag || drag.moved || event.type !== "pointerup" || this.#activeCluster) return;
      // 总览里点按星团即进入；群内的点击由卡片自己处理（打开详情）。
      const point = local(event);
      const cluster = this.#clusterAt(point.x, point.y);
      if (cluster) this.#enter(cluster, false);
    };
    element.addEventListener("pointerup", release, { signal });
    element.addEventListener("pointercancel", release, { signal });
    element.addEventListener(
      "wheel",
      (event) => {
        if (!this.#inputEnabled) return;
        event.preventDefault();
        const point = local(event);
        this.#zoom(Math.exp(clamp(event.deltaY, -240, 240) * wheelZoomRate), point.x, point.y);
      },
      { passive: false, signal }
    );
  }

  /** 访客操作后暂缓自动播放，并把自动进入的星团视为访客接管。 */
  #touchCruise() {
    this.#cruiseSeconds = Math.min(this.#cruiseSeconds, -2.5);
    this.#cruiseEntered = false;
  }

  #clusterAt(x: number, y: number) {
    let best: ClusterState | undefined;
    for (const cluster of this.#clusters) {
      if (cluster.screenRadius === 0 || cluster.fade < 0.5) continue;
      if (Math.hypot(x - cluster.screenX, y - cluster.screenY) > cluster.screenRadius * 1.05) continue;
      if (!best || cluster.depth < best.depth) best = cluster;
    }
    return best;
  }

  /** factor > 1 表示缩小。 */
  #zoom(factor: number, x: number, y: number, pointerType?: string) {
    this.#touchCruise();
    // 缩小相当于往回退：和向上滚动一样唤出导航，放大则收起。
    this.#onManualVerticalMovement(-Math.log(factor) / wheelZoomRate, pointerType);
    const cluster = this.#activeCluster;
    if (cluster) {
      this.#zoomCluster(cluster, factor);
      return;
    }
    this.#overviewZoom = clamp(this.#overviewZoom * factor, 0.5, 1.12);
    let nearest: ClusterState | undefined;
    for (const candidate of this.#clusters) {
      if (
        !nearest ||
        Math.hypot(x - candidate.screenX, y - candidate.screenY) <
          Math.hypot(x - nearest.screenX, y - nearest.screenY)
      ) {
        nearest = candidate;
      }
    }
    this.#overviewPull = this.#overviewZoom < 1 ? (nearest ?? null) : null;
    if (this.#overviewZoom < 0.62 && nearest) this.#enter(nearest, false);
  }

  #zoomCluster(cluster: ClusterState, factor: number) {
    this.#zoomRate = 6;
    cluster.zoom = clamp(cluster.zoom / factor, cluster.range.exit * 0.85, cluster.range.maximum);
    // 缩到星团刚好填满屏幕短边为止，再往外就回到星群总览。
    if (cluster.zoom < cluster.range.exit * 0.999) {
      this.#exit(true);
      return;
    }
    this.#wanted.zoom = cluster.zoom * cluster.range.fill;
  }

  // ---------- 其他 ----------

  stats(): ShowPixiSceneStats {
    let activeSprites = 0;
    let textureReadySprites = 0;
    let visibleSprites = 0;
    let retainedDtos = 0;
    for (const cluster of this.#clusters) {
      retainedDtos += cluster.images.length;
      for (const slot of cluster.slots) {
        if (slot.card) {
          activeSprites += 1;
          if (slot.card.isTextureReady) textureReadySprites += 1;
        }
        if (slot.drawn) visibleSprites += 1;
      }
    }
    return {
      ...emptyShowPixiSceneStats(),
      activeSprites,
      textureReadySprites,
      visibleSprites,
      retainedDtos,
      recycledSprites: this.#recycledCards,
      inputEnabled: this.#inputEnabled,
      inputListenerCount: this.#destroyed ? 0 : 5,
      activePointers: this.#pointers.size
    };
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#listeners.abort();
    this.#pointers.clear();
    this.#activeCluster = null;
    this.#clearClusters();
    this.#glowTexture.destroy(true);
    this.root.destroy({ children: true });
  }
}
