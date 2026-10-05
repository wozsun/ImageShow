import { Color, Container, Graphics, Sprite, Text, Texture, type Renderer } from "pixi.js";
import { imageVariantUrl, type ShowOrder } from "@imageshow/shared/browser";
import {
  clusterCardGrowth,
  clusterCardSide,
  clusterCardSize,
  clusterExpand,
  clusterRing,
  clusterRingPoint,
  clusterQueueReserve,
  clusterRingCapacity,
  clusterRingQuarterArc,
  clusterOverviewRadius,
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
import type { ShowPixiTextureCache, ShowPixiTextureLod } from "./show-pixi-texture-cache.js";
import type {
  ShowPixiSceneController,
  ShowPixiSceneOptions,
  ShowPixiSceneStats,
  ShowPixiVisibleItem
} from "./show-pixi-types.js";
import { emptyShowPixiSceneStats } from "./show-pixi-types.js";

export type ShowClusterFocus = { key: string; name: string; total: number };

/** 怎样进入的星团：自动播放、点按星团、缩放（滚轮、双指或 ± 按钮）或方向键切换。 */
export type ShowClusterEntry = "cruise" | "click" | "zoom" | "step";

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
  /** entry 只在进入星团时给出；名称与数量更新、回到总览时没有。 */
  onClusterFocusChange: (focus: ShowClusterFocus | null, entry?: ShowClusterEntry) => void;
  onManualVerticalMovement: (delta: number, pointerType?: string) => void;
  onNeedClusterImages: (key: string, retainedIds: readonly string[]) => void;
};

type Vector = [number, number, number];
type RingPlan = {
  stretch: number;
  minimumMinor: number;
  /** 环最长能有多长：再长星团在总览里就太小，或环放不进画面。 */
  circumference: number;
};
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
  /** 最近一次协调分给卡片的贴图档位：保留不重新分配时按它计入预算。 */
  textureLod: ShowPixiTextureLod | null;
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
  /** 在环上占的弧长：总览里的球加探出的卡片，再加上与相邻星团的间隔。 */
  arc: number;
  ringArc: number;
  /** 上一帧在换位点的哪一侧（-1 / 1）：越过换位点中心时换成下一个分类。 */
  swapSide: number;
  /** 轮换中离换位点越近越透明（0–1），整环展示时恒为 1。 */
  presence: number;
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
  /** 星团内上一次换图之后过了多久（与环上的换位点无关）。 */
  imageSwapElapsedMs: number;
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

// 竖直视角：竖屏只看到横向星环的中段，近处一排离镜头近、显得很大，远处一排却挤满一屏。
// 竖屏改用较窄的视角、镜头相应退远，透视更平，前后两排的星团数量与大小更接近；环的形状不变。
const landscapeFieldOfViewTangent = Math.tan((50 * Math.PI) / 360);
const portraitFieldOfViewTangent = Math.tan((28 * Math.PI) / 360);
const defaultDriftSpeed = 28;
const spinRate = 0.1;
const dragRate = 0.006;
const ringPeriodSeconds = 150;
// 一组星群刚出现时先完整展示这么久，自动播放才开始挑星团进入。
const overviewIntroSeconds = 4;
// 环向观看者倾斜的角度；上下拖动只在它上下 leanLimit 以内微调。
const ringTilt = 0.6;
const leanLimit = 0.22;
const maximumVisibleItems = 96;
// 星团名称：名称 15px，数量 12px 排在下方 20px 处，整块约 36px 高。
const labelCountOffset = 20;
const labelHeight = 36;
const reconcileIntervalMs = 200;
const wheelZoomRate = 0.0014;
// 手指拖动走过这段距离才确认是单指拖动、开始收放导航；在此之前另一根手指落下就按捏合处理。
const touchDragConfirmDistance = 32;
// 轮换队列两端各提前请求首批图片的分类数。
const queuePrefetch = 6;
// 惯性按每 1/60 秒的位移计、以 e^(-3.5t) 衰减，累计约为初速的 17 倍。
const wheelInertiaFrames = 17;
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
  readonly #onClusterFocusChange: ClusterSceneOptions["onClusterFocusChange"];
  readonly #onManualVerticalMovement: (delta: number, pointerType?: string) => void;
  readonly #pointers = new Map<number, { x: number; y: number }>();
  #clusters: ClusterState[] = [];
  #dataKey = "";
  #width: number;
  #height: number;
  #focalLength = 1;
  #fieldOfViewTangent = landscapeFieldOfViewTangent;
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
  // 星群环：平放并向观看者倾斜，星团近大远小。竖屏沿用同一条环，左右超出屏幕的部分不画。
  #ring: ClusterRing = clusterRing(1, 2, 1);
  #ringRotation: Rotation = identity;
  #ringPhase = 0;
  #ringPhaseGoal: number | null = null;
  #ringFling = 0;
  #ringLean = 0;
  #ringLine = 1;
  /** 环按这个宽度取景：竖屏按与横屏同高的画面布局。 */
  #layoutWidth = 1;
  /** 本组的全部分类（有图片的数量大于 0），按图片数量从多到少；未取得图片的 images 为空。 */
  #members = new Map<string, ShowCluster>();
  /**
   * 分类多于环上容得下的星团：环上的星团转过换位点（横屏在最远处正中，竖屏在屏幕外的左端）时
   * 换成队列里的下一个分类，所有分类依次轮流上环。
   */
  #rotating = false;
  /** 还没上环的分类，按出场先后排列：向前公转从队首取、向后从队尾取。 */
  #queue: string[] = [];
  /** 已请求过首批图片的分类，不重复请求。 */
  #requestedKeys = new Set<string>();
  #ringDirection = 1;
  #lastRingPhase = 0;
  /** 上一次布局是否为竖屏：切换横竖屏时倾角回到各自的默认值。 */
  #portrait: boolean | null = null;
  #overviewDistance = 2000;
  #overviewZoom = 1;
  #overviewPull: ClusterState | null = null;
  /**
   * 总览镜头的上下偏移（世界单位）：前排的星团离得近、更大，下方还有名称，环心对准画面中央时
   * 整条环看起来偏下。按画面上实际占的上下范围在整个视口（导航收起时）里居中。
   */
  #overviewLift = 0;
  #depthNear = 0;
  #depthSpan = 1;
  #activeCluster: ClusterState | null = null;
  /** 刚从星团回到总览、镜头还在退回途中：各星团照旧持有卡片与档位，等镜头停稳再按总览重新协调。 */
  #returning = false;
  /**
   * 回到总览之前获得过焦点的星团（方向键切走的与刚退出的）：卡片还是放大时的高档位，
   * 照常换档与释放，不占用保留预算，否则连续切换后当前星团会被挤到很低的档位。
   */
  readonly #focusedSinceOverview = new Set<ClusterState>();
  /** 浏览星团期间环按新尺寸重排过：回到总览时直接按新布局取总览距离与居中位置。 */
  #relaidWhileFocused = false;
  #visitedKey = "";
  #cruiseSeconds = 0;
  #cruiseEntered = false;
  #drag: {
    x: number;
    y: number;
    startX: number;
    startY: number;
    moved: boolean;
    /** 手指拖动已走过确认距离，之后的位移直接交给导航。 */
    navigating: boolean;
    /** 确认前暂存的导航位移：第二根手指在此期间落下就是捏合，丢弃它。 */
    pendingNavigation: number;
  } | null = null;
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
    this.#updateFocalLength();
    this.setClusters(options.clusters, options.dataKey);
  }

  // ---------- 数据 ----------

  setImages(_images: readonly ShowImage[], _dataKey: string, _order: ShowOrder, _hasMore: boolean) {
    // 星群不消费展映的单一图片流；它的数据经 setClusters 进入。
  }

  setClusters(clusters: readonly ShowCluster[], dataKey: string) {
    if (this.#destroyed) return;
    this.#members = new Map(clusters.map((cluster) => [cluster.key, cluster]));
    if (dataKey !== this.#dataKey || this.#clusters.length === 0) {
      this.#requestedKeys.clear();
      this.#dataKey = dataKey;
      this.#exit();
      this.#returning = false;
      this.#focusedSinceOverview.clear();
      this.#clearClusters();
      this.#visitedKey = "";
      this.#overviewZoom = 1;
      this.#overviewPull = null;
      this.#ringFling = 0;
      this.#cruiseSeconds = -overviewIntroSeconds;
      this.#overviewLift = 0;
      this.#arrange("reset");
      // 新的一组星群从远处推近，和页面初次进入时一致。
      if (this.#clusters.length > 0) this.#camera.distance = this.#overviewDistance * 1.9;
      return;
    }
    const removedClusters = this.#clusters.filter(
      (cluster) => !this.#members.get(cluster.key)?.images.length
    );
    if (removedClusters.length > 0) {
      this.#clearCardHover();
      if (this.#activeCluster && removedClusters.includes(this.#activeCluster)) this.#exit();
      if (this.#overviewPull && removedClusters.includes(this.#overviewPull)) this.#overviewPull = null;
      for (const cluster of removedClusters) this.#destroyCluster(cluster);
      this.#clusters = this.#clusters.filter((cluster) => !removedClusters.includes(cluster));
      this.#publishVisibleItems([]);
    }
    // 首批失败后又取得的分类：全都放得下时直接上环，否则留在队列里等轮换。
    const loadedOffRing = [...this.#members.values()].some(
      (member) =>
        member.images.length > 0 && !this.#clusters.some((cluster) => cluster.key === member.key)
    );
    if (removedClusters.length > 0) this.#arrange("relayout");
    else if (loadedOffRing || this.#rotating) this.#arrange("update");
    for (const state of this.#clusters) {
      const next = this.#members.get(state.key);
      if (!next) continue;
      if (state.name !== next.name) {
        state.name = next.name;
        state.title.text = next.name;
        if (state === this.#activeCluster)
          this.#onClusterFocusChange({ key: state.key, name: state.name, total: next.total });
      }
      if (next.images === state.images) continue;
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
          this.#onClusterFocusChange({ key: state.key, name: state.name, total: state.total });
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

  /** fade：出现时的显现程度。整环展示时后来补上的星团从 0 渐渐显现；轮换替换的星团按位置渐显。 */
  #createCluster(cluster: ShowCluster, fade: number): ClusterState {
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
      textureLod: null,
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
    count.y = labelCountOffset;
    label.addChild(name, count);
    this.#labels.addChild(label);
    const glow = new Sprite(this.#glowTexture);
    glow.anchor.set(0.5);
    glow.blendMode = "add";
    // 轮换出场的星团在本帧定位之后才创建：先隐藏，由逐帧更新定位后再显示，不在画面原点闪一下。
    label.visible = false;
    glow.visible = false;
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
      arc: 2 * (sphere.overviewRadius + clusterCardSide * 0.7) + 50,
      ringArc: 0,
      swapSide: 1,
      presence: 1,
      position: [0, 0, 0],
      screenX: 0,
      screenY: 0,
      screenRadius: 0,
      depth: 0,
      far: 0,
      bright: 1,
      fade,
      active: 0,
      zoom: 1,
      range: { fill: 1, entry: 1, exit: 0.5, maximum: 2 },
      imageSwapElapsedMs: 0,
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
    this.#queue = [];
    this.#rotating = false;
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

  #updateFocalLength() {
    this.#fieldOfViewTangent =
      this.#width < this.#height ? portraitFieldOfViewTangent : landscapeFieldOfViewTangent;
    this.#focalLength = this.#height / 2 / this.#fieldOfViewTangent;
  }

  resize(width: number, height: number) {
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);
    this.#updateFocalLength();
    this.#arrange("relayout");
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

  /** 分类上环时占的弧长；还没取得图片的按它应有的同屏数量估算。 */
  #arcFor(member: ShowCluster) {
    const shown = clusterShownCount(member.total);
    const radius = clusterOverviewRadius(
      member.images.length > 0 ? Math.min(shown, member.images.length) : shown
    );
    return 2 * (radius + clusterCardSide * 0.7) + 50;
  }

  /**
   * 环能有多大：中位星团在总览里的屏幕半径不小于短边的 3.5%（至少 20 像素），且整条环放得进画面。
   * 竖屏按与横屏同高的画面布局，环与横屏一致，左右超出屏幕的部分不画。
   */
  #ringPlan(): RingPlan {
    const width = this.#layoutWidth;
    const halfWidth = Math.max(1, width / 2 - 20);
    const halfHeight = Math.max(1, this.#height / 2 - 88);
    const stretch = clamp((halfWidth / Math.max(1, this.#height / 2 - 96)) * 0.95, 1.6, 2.8);
    const arcs = [...this.#members.values()]
      .slice(0, clusterRingCapacity)
      .map((member) => this.#arcFor(member))
      .sort((left, right) => left - right);
    const middleArc = arcs[Math.floor(arcs.length / 2)] ?? 210;
    const largest = Math.max(80, ...arcs.map((arc) => (arc - 50) / 2));
    const median = (middleArc - 50) / 2 - clusterCardSide * 0.7;
    const distance =
      (median * this.#focalLength) / Math.max(20, Math.min(width, this.#height) * 0.035);
    const perHeight = this.#focalLength / halfHeight;
    const tilt = ringTilt + this.#ringLean;
    const minimumMinor = largest * 1.7;
    const minor = Math.max(
      minimumMinor,
      Math.min(
        (distance - largest * perHeight) / (Math.cos(tilt) + Math.sin(tilt) * perHeight),
        ((distance * halfWidth) / this.#focalLength - largest) / stretch
      )
    );
    return {
      stretch,
      minimumMinor,
      circumference: clusterRing(0, stretch, 1).length * minor
    };
  }

  /**
   * 决定哪些分类上环、环多大，并排好位置。分类都放得下时整条环展示全部分类；
   * 放不下时在换位点轮换分类。reset 从头挑选；relayout 保留环上的星团、按新尺寸增减后重排；
   * update 只在环上的星团需要变化时才重排。
   */
  #arrange(reason: "reset" | "relayout" | "update") {
    // 竖屏按与横屏同高的较宽画面布局，左右超出屏幕的部分不画；横屏按实际宽度整环入画。
    const portrait = this.#width < this.#height;
    this.#layoutWidth = portrait ? this.#height * 1.6 : this.#width;
    if (portrait !== this.#portrait) {
      // 竖屏默认把环放到最平（相当于往上拖到头），前后两排靠近，中间不至于太空。
      this.#portrait = portrait;
      this.#ringLean = portrait ? -leanLimit : 0;
    }
    const plan = this.#ringPlan();
    this.#orientRing();
    const members = [...this.#members.values()];
    const loaded = members.filter((member) => member.images.length > 0);
    // 全部分类（未取得图片的按应有的同屏数量估算）都放得下时整环展示已取得的分类，
    // 首批还没到或失败的分类取得后再补上，环不会因此改成轮换。
    const fitsAll =
      members.length <= clusterRingCapacity &&
      members.reduce((sum, member) => sum + this.#arcFor(member), 0) * 1.06 <= plan.circumference;
    if (fitsAll) {
      if (
        reason === "update" &&
        !this.#rotating &&
        loaded.every((member) => this.#onRing(member.key))
      )
        return;
      for (const member of loaded) {
        if (!this.#onRing(member.key)) {
          this.#clusters.push(this.#createCluster(member, reason === "reset" ? 1 : 0));
        }
      }
      this.#rotating = false;
      this.#queue = [];
      this.#layoutWholeRing(plan);
    } else {
      if (reason === "update" && this.#rotating) {
        this.#syncQueue();
        return;
      }
      this.#rotating = true;
      let ring: ClusterState[];
      let used = 0;
      const fits = (arc: number) => (used + arc) * 1.06 <= plan.circumference;
      if (reason === "reset") {
        ring = [];
        for (const member of loaded) {
          const arc = this.#arcFor(member);
          if (ring.length >= clusterRingCapacity) break;
          if (ring.length > 0 && !fits(arc)) continue;
          ring.push(this.#createCluster(member, 1));
          used += arc;
        }
        this.#queue = [];
      } else {
        // 保留环上的星团：放不下的退回队首，画面变大时从队首补入，环的大小始终跟着画面走。
        ring = [...this.#clusters];
        used = ring.reduce((sum, cluster) => sum + cluster.arc, 0);
        while (ring.length > 1 && used * 1.06 > plan.circumference) {
          // 正在浏览的星团跳过，不会因窗口变化被带回总览。
          const index = ring.findLastIndex((cluster) => cluster !== this.#activeCluster);
          const dropped = ring.splice(index, 1)[0]!;
          used -= dropped.arc;
          if (dropped === this.#overviewPull) this.#overviewPull = null;
          this.#destroyCluster(dropped);
          this.#queue.unshift(dropped.key);
        }
        for (const key of [...this.#queue]) {
          const member = this.#members.get(key);
          if (!member?.images.length) continue;
          const arc = this.#arcFor(member);
          if (ring.length >= clusterRingCapacity || !fits(arc)) break;
          this.#queue.splice(this.#queue.indexOf(key), 1);
          ring.push(this.#createCluster(member, 0));
          used += arc;
        }
      }
      this.#clusters = ring;
      this.#syncQueue();
      this.#layoutWholeRing(plan);
    }
    const active = this.#activeCluster;
    // 浏览星团期间重排了环：等其余星团隐去后再把当前星团换到最前端，回到总览时直接取新的居中位置。
    if (active) {
      this.#ringPhaseGoal = this.#phaseGoalFor(active);
      this.#relaidWhileFocused = true;
    }
    this.#orbit.clear();
    for (const cluster of this.#clusters) {
      cluster.position = this.#ringPosition(cluster);
      cluster.swapSide = this.#swapOffset(cluster) < 0 ? -1 : 1;
    }
    if (reason !== "update" && !active) {
      // 新的一组星群或画面尺寸变化：总览距离与导航收起时的居中位置都按新布局直接取，不从旧位置浮过去。
      this.#overviewDistance = this.#ringFitDistance();
      this.#overviewLift = this.#centeredLift();
      if (reason === "reset") this.#camera.target = [0, -this.#overviewLift, 0];
    }
  }

  /** 镜头停在总览（不拉近、正对环心）时，让星环上下范围在视口居中所需的镜头偏移。 */
  #centeredLift() {
    const distance = this.#overviewDistance;
    let top = Infinity;
    let bottom = -Infinity;
    for (const cluster of this.#clusters) {
      const [, y, z] = cluster.position;
      const depth = distance - z;
      if (depth < 8) continue;
      const scale = this.#focalLength / depth;
      const screenY = -y * scale;
      const radius = cluster.overviewRadius * scale;
      top = Math.min(top, screenY - radius * 1.2);
      bottom = Math.max(bottom, screenY + radius * 0.96 + 8 + labelHeight);
    }
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) return 0;
    return (((top + bottom) / 2) * distance) / this.#focalLength;
  }

  /** 让星团转到屏幕中间靠前处的环相位，取离当前相位最近的一圈。 */
  #phaseGoalFor(cluster: ClusterState) {
    const goal = this.#focusArc() - cluster.ringArc;
    return goal + this.#ring.length * Math.round((this.#ringPhase - goal) / this.#ring.length);
  }

  #onRing(key: string) {
    return this.#clusters.some((cluster) => cluster.key === key);
  }

  /** 队列只留仍存在、未上环的分类；新出现的分类排到末尾。 */
  #syncQueue() {
    const onRing = new Set(this.#clusters.map((cluster) => cluster.key));
    this.#queue = this.#queue.filter((key) => this.#members.has(key) && !onRing.has(key));
    const queued = new Set(this.#queue);
    for (const key of this.#members.keys()) {
      if (!onRing.has(key) && !queued.has(key)) this.#queue.push(key);
    }
  }

  /** 环上的星团大小交错，按占的弧长等比铺满整条环；轮换时位置不变，只换分类。 */
  #layoutWholeRing(plan: RingPlan) {
    if (this.#clusters.length === 0) return;
    const sorted = [...this.#clusters].sort(
      (left, right) => right.overviewRadius - left.overviewRadius
    );
    const order: ClusterState[] = [];
    while (sorted.length > 0) {
      order.push(sorted.shift()!);
      if (sorted.length > 0) order.push(sorted.pop()!);
    }
    const total = order.reduce((sum, cluster) => sum + cluster.arc, 0);
    this.#ring = clusterRing(total * 1.06, plan.stretch, plan.minimumMinor);
    let cursor = 0;
    for (const cluster of order) {
      cluster.ringArc = ((cursor + cluster.arc / 2) / total) * this.#ring.length;
      cursor += cluster.arc;
    }
    this.#clusters = order;
  }

  #wrap(arc: number) {
    return ((arc % this.#ring.length) + this.#ring.length) % this.#ring.length;
  }

  /** 星团中心相对换位点的弧长，取 (-周长/2, 周长/2]，正值在公转方向的前方。 */
  #swapOffset(cluster: ClusterState) {
    const offset = this.#wrap(cluster.ringArc + this.#ringPhase - this.#swapArc());
    return offset > this.#ring.length / 2 ? offset - this.#ring.length : offset;
  }

  /**
   * 换位点的弧长位置，不随公转变化：横屏在环的最远处正中；竖屏只看得到环的中段，
   * 放在屏幕外的左端，换分类完全在画面之外进行。
   */
  #swapArc() {
    return clusterRingQuarterArc(this.#ring, this.#width < this.#height ? 2 : 3);
  }

  /**
   * 轮换中靠近换位点的星团按距离渐隐：换分类只发生在看不见的位置，拖得再快也只有换位点附近
   * 一两个星团是半透明的。整环展示时恒为 1。
   */
  #presenceOf(cluster: ClusterState) {
    if (!this.#rotating) return 1;
    const spacing = this.#ring.length / Math.max(1, this.#clusters.length);
    const distance = Math.abs(this.#swapOffset(cluster));
    return ease(clamp((distance - spacing * 0.15) / (spacing * 0.7), 0, 1));
  }

  /**
   * 轮换：星团转过换位点中心时原地换成队列里的下一个分类，旧分类按来向放回队列，两个方向都可逆。
   * 没有已取得图片的分类可换时星团照常穿过，环上不会空出位置。
   */
  #stepRotation() {
    if (!this.#rotating) return;
    // 浏览星团与回到总览的途中不换分类，但照常记下各星团在换位点哪一侧：
    // 进入时环会一次性换位，不能在回到总览后把换位途中越过的星团当成刚越过。
    const swapping = !this.#activeCluster && !this.#returning;
    // 环上还没有星团（例如首批全部失败）时不预取，恢复后的分类按原顺序上环。
    if (swapping && this.#clusters.length > 0) this.#prefetchQueued();
    const forward = this.#ringDirection >= 0;
    let candidates: string[] | null = null;
    this.#clusters.forEach((cluster, index) => {
      const offset = this.#swapOffset(cluster);
      const side = offset < 0 ? -1 : 1;
      // 只认换位点中心附近的越过；环的另一侧在 ±周长/2 处折返，不算。
      const crossed = side !== cluster.swapSide && Math.abs(offset) < this.#ring.length / 4;
      cluster.swapSide = side;
      if (!swapping || !crossed || cluster === this.#overviewPull) return;
      candidates ??= this.#readyQueued(forward);
      const key = candidates.shift();
      if (!key) return;
      const next = this.#createCluster(this.#members.get(key)!, 1);
      next.ringArc = cluster.ringArc;
      next.swapSide = side;
      next.position = this.#ringPosition(next);
      this.#queue.splice(this.#queue.indexOf(key), 1);
      // 向前公转时换下的分类排到队尾，往回转时它最先回来。
      if (side > 0) this.#queue.push(cluster.key);
      else this.#queue.unshift(cluster.key);
      this.#destroyCluster(cluster);
      this.#clusters[index] = next;
    });
  }

  /** 队列两端各提前请求几个分类的首批图片，快速拖动或往回转时都有分类可换。 */
  #prefetchQueued() {
    for (const key of [...this.#queue.slice(0, queuePrefetch), ...this.#queue.slice(-queuePrefetch)]) {
      if (this.#members.get(key)?.images.length || this.#requestedKeys.has(key)) continue;
      this.#requestedKeys.add(key);
      this.#onNeedClusterImages(key, []);
    }
  }

  /**
   * 按公转方向列出可以换上的分类：队列前半段里已取得图片、且不在环上的。
   * 刚换下的分类排在后半段，不会马上又换回来。
   */
  #readyQueued(forward: boolean) {
    const ordered = forward ? this.#queue : [...this.#queue].reverse();
    return ordered
      .slice(0, Math.max(3, Math.ceil(ordered.length / 2)))
      .filter((key) => (this.#members.get(key)?.images.length ?? 0) > 0 && !this.#onRing(key));
  }

  #orientRing() {
    this.#ringRotation = rotate(identity, [1, 0, 0], ringTilt + this.#ringLean);
  }

  #ringPosition(cluster: ClusterState): Vector {
    // 只有一个星团时没有“环”可言：它就在画面正中，不绕着空环公转。
    if (this.#clusters.length === 1 && !this.#rotating) return [0, 0, 0];
    const point = clusterRingPoint(this.#ring, cluster.ringArc + this.#ringPhase);
    return turned(this.#ringRotation, point.u, 0, point.v);
  }

  /** 星团转到这里时处在屏幕中间靠下的位置：环的最前端。 */
  #focusArc() {
    return clusterRingQuarterArc(this.#ring, 1);
  }

  #ringFitDistance() {
    const halfWidth = Math.max(1, this.#layoutWidth / 2 - 20);
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
    return (radius / (this.#fieldOfViewTangent * Math.min(1, this.#width / this.#height))) * 1.06;
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
      this.#exit();
    } else if (command.type === "step") {
      // 上一个 / 下一个星团：沿环的公转方向依次切换。
      const current =
        cluster ?? this.#clusters.find((candidate) => candidate.key === this.#visitedKey);
      const next = current ? this.#ringNeighbour(current, command.direction) : this.#frontCluster();
      if (next) this.#enter(next, "step");
    } else if (cluster) {
      // 群内按一格缩放，缩到底回到总览。
      this.#zoomCluster(cluster, command.direction > 0 ? 1 / 1.25 : 1.25);
    } else if (command.direction > 0) {
      // 总览里放大即进入最靠近屏幕中间的星团。
      const front = this.#frontCluster();
      if (front) this.#enter(front, "zoom");
    }
  }

  #enter(cluster: ClusterState, entry: ShowClusterEntry) {
    if (this.#activeCluster === cluster) return;
    // 回到总览途中又进入星团：上一次浏览的记录已不再需要。
    if (this.#returning) this.#focusedSinceOverview.clear();
    if (this.#activeCluster) this.#focusedSinceOverview.add(this.#activeCluster);
    this.#activeCluster = cluster;
    this.#returning = false;
    this.#visitedKey = cluster.key;
    this.#overviewZoom = 1;
    this.#overviewPull = null;
    cluster.range = this.#zoomRange(cluster);
    cluster.zoom = cluster.range.entry;
    cluster.fling = [0, 0];
    // 进入时环不动。等其余星团隐去后，再把环换到“当前星团在屏幕中间”的位置（见 #stepRing）。
    this.#ringPhaseGoal = this.#phaseGoalFor(cluster);
    this.#wanted.distance = this.#fitDistance(cluster);
    this.#wanted.pitch = 0.1;
    this.#wanted.zoom = cluster.zoom * cluster.range.fill;
    this.#zoomRate = 2.6;
    this.#cruiseSeconds = 0;
    this.#cruiseEntered = entry === "cruise";
    this.#lastVisibleSignature = null;
    this.#onClusterFocusChange(
      { key: cluster.key, name: cluster.name, total: cluster.total },
      entry
    );
  }

  #exit() {
    if (!this.#activeCluster) return;
    this.#focusedSinceOverview.add(this.#activeCluster);
    this.#activeCluster = null;
    if (this.#relaidWhileFocused) {
      this.#relaidWhileFocused = false;
      this.#overviewDistance = this.#ringFitDistance();
      this.#overviewLift = this.#centeredLift();
    }
    this.#returning = true;
    this.#ringPhaseGoal = null;
    this.#overviewZoom = 1;
    this.#wanted.zoom = 1;
    this.#wanted.pitch = 0;
    this.#zoomRate = 2.6;
    // 访客自己退出时保留刚得到的暂缓，不立刻被自动播放带进下一个星团。
    this.#cruiseSeconds = Math.min(this.#cruiseSeconds, 0);
    this.#clearCardHover();
    this.#publishVisibleItems([]);
    this.#onClusterFocusChange(null);
  }

  #ringNeighbour(cluster: ClusterState, direction: number) {
    // 换位点附近渐隐的星团跳过：它随时可能换成别的分类。
    const order = this.#clusters
      .filter((candidate) => candidate === cluster || candidate.presence >= 0.5)
      .sort((left, right) => this.#wrap(left.ringArc) - this.#wrap(right.ringArc));
    const count = order.length;
    const index = order.indexOf(cluster);
    // 环公转时弧长位置小一位的星团接着转过来，所以“下一个”取序号减一。
    return order[(((index - direction) % count) + count) % count];
  }

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
      if (cluster.presence < 0.5) continue;
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
    this.#centerOverview(elapsed);
    this.#stepRotation();
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
        this.#exit();
      }
      return;
    }
    // 环在公转：哪个星团转到屏幕中间就放大哪个；刚看过的那个还停在中间，等下一个转过来。
    if (this.#cruiseSeconds < 1.2) return;
    const front = this.#frontCluster();
    if (!front) return;
    if (this.#clusters.length === 1) {
      if (this.#cruiseSeconds > 5.5) this.#enter(front, "cruise");
      return;
    }
    const focus = this.#frontPoint();
    if (!this.#project(focus[0], focus[1], focus[2])) return;
    const offset =
      Math.hypot(front.screenX - this.#projected.x, front.screenY - this.#projected.y) /
      Math.min(this.#width, this.#height);
    if (offset < 0.1 && front.key !== this.#visitedKey) this.#enter(front, "cruise");
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
        this.#lastRingPhase = this.#ringPhase;
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
    // 轮换按最近一次公转的方向从队列取下一个分类。
    const turn = this.#ringPhase - this.#lastRingPhase;
    if (Math.abs(turn) > 0.001) this.#ringDirection = Math.sign(turn);
    this.#lastRingPhase = this.#ringPhase;
    this.#overviewDistance += (this.#ringFitDistance() - this.#overviewDistance) * damp(elapsed, 2.5);
  }

  #stepCamera(elapsed: number) {
    const active = this.#activeCluster;
    if (active) {
      this.#wanted.target = active.position;
    } else {
      const pull = this.#overviewPull ? clamp((1 - this.#overviewZoom) / 0.4, 0, 1) * 0.75 : 0;
      const towards = this.#overviewPull?.position ?? [0, 0, 0];
      this.#wanted.target = [
        towards[0] * pull,
        towards[1] * pull - this.#overviewLift,
        towards[2] * pull
      ];
      this.#wanted.distance = this.#overviewDistance * this.#overviewZoom;
    }
    const follow = damp(elapsed, 3);
    for (let axis = 0; axis < 3; axis += 1) {
      this.#camera.target[axis]! += (this.#wanted.target[axis]! - this.#camera.target[axis]!) * follow;
    }
    this.#camera.pitch += (this.#wanted.pitch - this.#camera.pitch) * follow;
    this.#camera.distance += (this.#wanted.distance - this.#camera.distance) * follow;
    this.#camera.zoom += (this.#wanted.zoom - this.#camera.zoom) * damp(elapsed, this.#zoomRate);
    if (
      this.#returning &&
      Math.abs(this.#camera.zoom - this.#wanted.zoom) < this.#wanted.zoom * 0.03 &&
      Math.abs(this.#camera.distance - this.#wanted.distance) < this.#wanted.distance * 0.05
    ) {
      this.#returning = false;
      this.#focusedSinceOverview.clear();
    }
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

  /** 镜头停在总览时，把画面上星环的上下范围（含卡片探出的部分与名称）移到视口中央。 */
  #centerOverview(elapsed: number) {
    if (
      this.#activeCluster ||
      this.#returning ||
      this.#overviewPull ||
      Math.abs(this.#camera.distance - this.#wanted.distance) > this.#wanted.distance * 0.05
    )
      return;
    let top = Infinity;
    let bottom = -Infinity;
    for (const cluster of this.#clusters) {
      if (cluster.screenRadius === 0) continue;
      top = Math.min(top, cluster.screenY - cluster.screenRadius * 1.2);
      bottom = Math.max(
        bottom,
        cluster.screenY + cluster.screenRadius * 0.96 + 8 + labelHeight
      );
    }
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) return;
    const offset = (top + bottom) / 2 - this.#height / 2;
    // 画面上的像素换算到环心深处的世界距离。
    const perPixel = this.#camera.distance / (this.#focalLength * this.#camera.zoom);
    // 起始位置已按居中算好，这里只跟随转动带来的细微变化，慢一些不会来回晃。
    this.#overviewLift += offset * perPixel * damp(elapsed, 1);
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
      const blocking = cluster.depth < focus.depth + focus.radius * clusterExpand;
      const pulledBack =
        (focus.range.entry - this.#camera.zoom / focus.range.fill) /
        Math.max(0.05, focus.range.entry - focus.range.exit);
      fade = blocking ? 0 : clamp(pulledBack, 0, 1);
    }
    cluster.fade += (fade - cluster.fade) * damp(elapsed, 5);
    cluster.presence = this.#presenceOf(cluster);
    // 画出来的显现程度：焦点切换的淡入淡出，再乘上轮换换位点附近的渐隐。
    const visibility = cluster.fade * cluster.presence;
    // 浏览别的星团期间，进入时持有的卡片一直留着：镜头推近时它们移出画面、随后隐去，回到星群还要用。
    // 回到总览的途中同样留着，否则镜头退回时它们还在画面外，会先被释放再重新加载。
    const holding =
      ((focus !== null && !active) || this.#returning) && !this.#focusedSinceOverview.has(cluster);
    // 完全隐去后原样停住，不再自转：回到星群时朝向观看者的还是原来那些图。
    const frozen = holding && cluster.fade < 0.02;

    // 作背景的星团不换图：换进来的图暂时看不到，也就不必加载。
    if (moving && !holding) this.#rotateImages(cluster, active, elapsed);
    if (moving && !frozen) {
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
      this.#hideSlots(cluster, holding);
      return;
    }
    cluster.screenX = this.#projected.x;
    cluster.screenY = this.#projected.y;
    cluster.depth = this.#projected.depth;
    cluster.screenRadius = radius * this.#projected.scale;
    if (frozen) {
      cluster.glow.visible = false;
      cluster.label.visible = false;
      this.#hideSlots(cluster, true);
      return;
    }

    // 竖屏的环左右超出屏幕：画面外的星团不画光晕与名称。
    const margin = cluster.screenRadius * 1.6 + 120;
    const onScreen =
      cluster.screenX + margin > 0 &&
      cluster.screenX - margin < this.#width &&
      cluster.screenY + margin > 0 &&
      cluster.screenY - margin < this.#height;
    cluster.glow.visible = onScreen && visibility > 0.02;
    if (cluster.glow.visible) {
      cluster.glow.position.set(cluster.screenX, cluster.screenY);
      cluster.glow.width = cluster.glow.height = cluster.screenRadius * 3.1;
      // 总览里的光晕只托一下星团；进入星团后光晕铺满整个画面，只留一点点，不把背景整体照亮。
      cluster.glow.alpha = lerp(0.35, 0.12, e) * cluster.bright * visibility;
    }
    const labelVisible = !focus && onScreen && this.#labelUncovered(cluster);
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
      if (slot.vacant || visibility < 0.02 || !this.#project(cx + px, cy + py, cz + pz)) {
        slot.alpha = 0;
        slot.drawn = false;
        if (!holding || slot.vacant) slot.resident = false;
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
      slot.alpha = base * visibility * (slot.overview ? 1 : e);
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
      // 视口外一段距离内的卡片先备好贴图（见 #prerenderMargin），转动或缩小时进入画面的是图片。
      // 不看整团的淡入淡出；浏览别的星团期间只增不减，回到星群时不必重新加载。
      slot.resident =
        (holding && slot.resident) ||
        (base * (slot.overview ? 1 : e) > 0.01 &&
          x + width > -this.#prerenderMargin() &&
          x - width < this.#width + this.#prerenderMargin() &&
          y + height > -this.#height / 2 &&
          y - height < this.#height * 1.5);
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
      holder.alpha = slot.card.isInteractionActive ? visibility : slot.alpha;
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

  /**
   * 画面左右多远以内的卡片先备好贴图：转动时进入画面的是图片而不是占位色块。
   * 竖屏只显示环的中段，星团从屏幕外很快转进来，按半个屏幕高度提前准备。
   */
  #prerenderMargin() {
    return Math.max(this.#width, this.#height) / 2;
  }

  /** 整团不画。keepCards 时保留卡片与贴图租约，否则在下一次协调时释放。 */
  #hideSlots(cluster: ClusterState, keepCards: boolean) {
    for (const slot of cluster.slots) {
      slot.alpha = 0;
      slot.drawn = false;
      slot.raised = 0;
      slot.engaged = false;
      if (!keepCards || slot.vacant) slot.resident = false;
      if (slot.holder) slot.holder.visible = false;
    }
  }

  #placeLabel(cluster: ClusterState) {
    cluster.label.position.set(cluster.screenX, cluster.screenY + cluster.screenRadius * 0.96 + 8);
    cluster.label.alpha = (1 - 0.45 * cluster.far) * cluster.fade * cluster.presence;
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
    // 整个分类的图片都已取得：一轮走完从头再来，不再为同一批图片请求续页。
    const complete = cluster.images.length >= cluster.total;
    if (complete && cluster.total > cluster.slots.length && cluster.next >= cluster.images.length) {
      cluster.next = 0;
    }
    const remaining = cluster.images.length - cluster.next;
    if (
      !complete &&
      remaining < clusterQueueReserve &&
      !cluster.requested &&
      cluster.total > cluster.slots.length
    ) {
      cluster.requested = true;
      this.#onNeedClusterImages(
        cluster.key,
        cluster.slots.filter((slot) => !slot.vacant).map((slot) => slot.image.id)
      );
    }
    if (remaining <= 0) return;
    cluster.imageSwapElapsedMs += elapsed * 1000;
    // 总览里星团很小，慢慢换即可，也只换总览会画出来的位置。
    if (cluster.imageSwapElapsedMs < (active ? 500 : 6000)) return;
    const hidden = cluster.slots.filter((slot) => !slot.drawn && (active || slot.overview));
    if (hidden.length === 0) return;
    cluster.imageSwapElapsedMs = 0;
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
    const retained: SlotState[] = [];
    for (const cluster of [...this.#clusters].sort((left, right) => distance(left) - distance(right))) {
      // 作背景的星团已有的卡片原样保留，不随镜头远近换档：回到星群时还是总览里的那一档。
      const background =
        (this.#returning || this.#activeCluster !== null) &&
        cluster !== this.#activeCluster &&
        !this.#focusedSinceOverview.has(cluster);
      for (const slot of cluster.slots) {
        if (slot.resident && background && slot.card) retained.push(slot);
        else if (slot.resident) drawn.push(slot);
        // 看不见的槽位不持有卡片与贴图租约；转回来时重新创建。
        else if (slot.card && !slot.card.isInteractionActive) this.#releaseSlot(slot);
      }
    }
    const lods = this.#textureCache.fitResidentLods(
      drawn.map((slot) => ({
        url: imageVariantUrl(slot.image, "small"),
        lod: showPixiTextureLod(slot.image, Math.max(1, slot.screenWidth), slot.height / slot.width)
      })),
      retained.flatMap((slot) =>
        slot.textureLod ? [{ url: imageVariantUrl(slot.image, "small"), lod: slot.textureLod }] : []
      )
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
      slot.textureLod = lods[index] ?? null;
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
          this.#drag = {
            ...point,
            startX: point.x,
            startY: point.y,
            moved: false,
            navigating: event.pointerType === "mouse",
            pendingNavigation: 0
          };
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
            const factor = this.#pinchDistance / distance;
            const focused = this.#activeCluster !== null;
            this.#zoom(factor, (first!.x + second!.x) / 2, (first!.y + second!.y) / 2);
            // 双指放大收起导航；缩小时导航不动，直到从星团缩回星群总览才唤出。
            if (factor < 1) {
              this.#onManualVerticalMovement(-Math.log(factor) / wheelZoomRate, event.pointerType);
            } else if (focused && !this.#activeCluster) {
              this.#onManualVerticalMovement(-this.#height, event.pointerType);
            }
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
        // 与瀑布一致：向下拖动唤出导航，向上拖动收起；桌面的鼠标拖动只收起，唤出交给滚轮。
        // 两指捏合时手指不会同时落下：先落下的手指走过确认距离之前的位移先暂存，确认是单指拖动
        // 再交给导航，否则放大时导航会先被这段位移带出、再被捏合收起。
        if (!drag.navigating) {
          drag.pendingNavigation -= dy;
          if (Math.hypot(point.x - drag.startX, point.y - drag.startY) >= touchDragConfirmDistance) {
            drag.navigating = true;
            this.#onManualVerticalMovement(drag.pendingNavigation, event.pointerType);
            drag.pendingNavigation = 0;
          }
        } else {
          this.#onManualVerticalMovement(-dy, event.pointerType);
        }
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
        // 环只绕自己的轴转：左右拖动公转，上下拖动只微调倾角。
        this.#ringLean = clamp(this.#ringLean + dy * 0.0025, -leanLimit, leanLimit);
        this.#orientRing();
        this.#ringFling = clamp(-dx * this.#ringArcPerPixel(), -45, 45);
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
      if (cluster) this.#enter(cluster, "click");
    };
    element.addEventListener("pointerup", release, { signal });
    element.addEventListener("pointercancel", release, { signal });
    element.addEventListener(
      "wheel",
      (event) => {
        if (!this.#inputEnabled) return;
        event.preventDefault();
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.#height : 1;
        // Shift + 滚轮按横向滚动处理；多数浏览器已经换成 deltaX，没换的这里统一。
        const shifted = event.shiftKey && !event.ctrlKey && event.deltaX === 0;
        const deltaX = (shifted ? event.deltaY : event.deltaX) * unit;
        const deltaY = shifted ? 0 : event.deltaY * unit;
        if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
        // 任何滚动都是访客在操作：暂缓自动播放进入星团。
        this.#touchCruise();
        if (Math.abs(deltaX) > Math.abs(deltaY)) {
          // 横向滚动（触控板左右滑动或 Shift + 滚轮）像左右拖动一样转动星群或星团。
          // 只给惯性：一次滚动的总转动量约为同样距离拖动的转动量。
          const delta = clamp(deltaX, -240, 240);
          const cluster = this.#activeCluster;
          if (cluster) {
            const rate = dragRate / Math.max(1, this.#camera.zoom);
            cluster.fling[0] = clamp(cluster.fling[0] - (delta * rate) / wheelInertiaFrames, -0.08, 0.08);
            return;
          }
          this.#ringPhaseGoal = null;
          this.#ringFling = clamp(
            this.#ringFling + (delta * this.#ringArcPerPixel()) / wheelInertiaFrames,
            -45,
            45
          );
          return;
        }
        if (deltaY === 0) return;
        // 竖向滚动（含 Ctrl + 滚轮与触控板捏合）缩放：放大是往里看，收起导航；缩小是往回退，唤出导航。
        // 总览里放大朝指针附近的星团拉近，指针只决定拉近哪一个。
        const step = clamp(deltaY, -240, 240);
        const point = local(event);
        this.#onManualVerticalMovement(-step);
        this.#zoom(Math.exp(step * wheelZoomRate), point.x, point.y);
      },
      { passive: false, signal }
    );
  }

  /** 一个像素的拖动对应环上多长的一段：按环上离观看者最近处的成像比例折算。 */
  #ringArcPerPixel() {
    return Math.max(0.5, (this.#overviewDistance - this.#ring.minor * 0.8) / this.#focalLength);
  }

  /** 访客操作后暂缓自动播放，并把自动进入的星团视为访客接管。 */
  #touchCruise() {
    this.#cruiseSeconds = Math.min(this.#cruiseSeconds, -2.5);
    this.#cruiseEntered = false;
  }

  #clusterAt(x: number, y: number) {
    let best: ClusterState | undefined;
    for (const cluster of this.#clusters) {
      if (cluster.screenRadius === 0 || cluster.fade * cluster.presence < 0.5) continue;
      if (Math.hypot(x - cluster.screenX, y - cluster.screenY) > cluster.screenRadius * 1.05) continue;
      if (!best || cluster.depth < best.depth) best = cluster;
    }
    return best;
  }

  /** factor > 1 表示缩小。导航的显隐由滚轮与双指手势各自推动，± 按钮与键盘缩放不改变导航。 */
  #zoom(factor: number, x: number, y: number) {
    this.#touchCruise();
    const cluster = this.#activeCluster;
    if (cluster) {
      this.#zoomCluster(cluster, factor);
      return;
    }
    this.#overviewZoom = clamp(this.#overviewZoom * factor, 0.5, 1.12);
    let nearest: ClusterState | undefined;
    for (const candidate of this.#clusters) {
      // 换位点附近渐隐的星团不能被拉近或进入：它随时可能换成别的分类。
      if (candidate.presence < 0.5 || candidate.screenRadius === 0) continue;
      if (
        !nearest ||
        Math.hypot(x - candidate.screenX, y - candidate.screenY) <
          Math.hypot(x - nearest.screenX, y - nearest.screenY)
      ) {
        nearest = candidate;
      }
    }
    this.#overviewPull = this.#overviewZoom < 1 ? (nearest ?? null) : null;
    if (this.#overviewZoom < 0.62 && nearest) this.#enter(nearest, "zoom");
  }

  #zoomCluster(cluster: ClusterState, factor: number) {
    this.#zoomRate = 6;
    cluster.zoom = clamp(cluster.zoom / factor, cluster.range.exit * 0.85, cluster.range.maximum);
    // 缩到星团刚好填满屏幕短边为止，再往外就回到星群总览。
    if (cluster.zoom < cluster.range.exit * 0.999) {
      this.#exit();
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
