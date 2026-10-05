/** 星群模式的纯几何：同屏数量、星团球面格点、星群环与缩放阈值，不依赖 Pixi 与 DOM。 */

/** 卡片面积的边长（世界单位）：所有卡片面积相同，宽高按图片比例分配。 */
export const clusterCardSide = 46;
/** 进入星团后球面展开、卡片放大的倍率。展开倍率越小，正面的图片越密，轮廓附近相互遮挡也越多。 */
export const clusterExpand = 1.2;
export const clusterCardGrowth = 1.15;

/** 星群环上最多同时有多少个星团；分类更多时转过换位点的星团原地换成下一个分类。 */
export const clusterRingCapacity = 24;
/** 星团待上屏的图片少于这么多张时请求续页；首批与续页保留时也按它留出余量。 */
export const clusterQueueReserve = 24;

// 星团竖向略微压扁，行距更紧，放大后上下相邻的图更容易同时看全。
const clusterSquash = 0.82;
const goldenAngle = Math.PI * (3 - Math.sqrt(5));
const shownBase = 20;
const shownLimit = 120;

/** 小分类全部同屏；大分类按平方根压缩并封顶，其余图片排队轮换。 */
export function clusterShownCount(total: number) {
  if (total <= shownBase) return Math.max(0, Math.floor(total));
  return Math.min(shownLimit, Math.round(shownBase * Math.sqrt(total / shownBase)));
}

/** 星群总览里每个星团只画一部分图片：星团在总览里很小，画满只会多发图片请求。 */
function clusterOverviewCount(shown: number) {
  return shown <= 16 ? shown : Math.round(12 + shown * 0.25);
}

/** 星群总览里星团的球半径：按总览实际画出的数量算，各星团的疏密因此一致。 */
export function clusterOverviewRadius(shown: number) {
  // 总览只画朝向观看者的一面，没有背面的图片垫底，所以排得比展开后更密一些。
  return Math.max(48, clusterCardSide * Math.sqrt(clusterOverviewCount(shown) / (3.2 * Math.PI)));
}

export function clusterCardSize(image: { width: number; height: number }) {
  const ratio = image.width / Math.max(1, image.height);
  const aspect = Math.min(2.4, Math.max(0.42, Number.isFinite(ratio) && ratio > 0 ? ratio : 1));
  return { width: clusterCardSide * Math.sqrt(aspect), height: clusterCardSide / Math.sqrt(aspect) };
}

export type ClusterPoint = {
  /** 球面上的方向（竖向已压扁），y 轴向上。 */
  direction: readonly [number, number, number];
  /** 离球心的远近（0.7–1）：总览里卡片有深有浅，星团显得饱满。 */
  reach: number;
  /** 星群总览里也画出来；其余位置进入星团后才出现。 */
  overview: boolean;
};

export type ClusterSphere = {
  /** 全部位置都画出来时的球半径；进入后乘以 clusterExpand。 */
  radius: number;
  /** 星群总览里的球半径：按总览实际画出的数量算，各星团的疏密因此一致。 */
  overviewRadius: number;
  points: ClusterPoint[];
};

/**
 * 星团：图片在球面上按斐波那契格点均匀分布，两极没有空洞，转到任何角度正面的疏密都一样。
 * 位置与图片无关，所以轮换时任何图片都可以换进任何位置。
 */
export function clusterSphereLayout(count: number, random: () => number = Math.random): ClusterSphere {
  const lattice = (size: number) =>
    Array.from({ length: size }, (_, index): [number, number, number] => {
      const height = 1 - (2 * index + 1) / size;
      const ring = Math.sqrt(1 - height * height);
      const angle = index * goldenAngle;
      return [Math.sin(angle) * ring, height * clusterSquash, Math.cos(angle) * ring];
    });
  const points = lattice(count).map(
    (direction): ClusterPoint => ({ direction, reach: 0.7 + 0.3 * random(), overview: false })
  );
  // 总览用的子集同样要均匀：取一组更稀的格点，各自认领离它最近的位置。
  for (const [x, y, z] of lattice(clusterOverviewCount(count))) {
    let nearest: ClusterPoint | undefined;
    let nearestDistance = Infinity;
    for (const point of points) {
      if (point.overview) continue;
      const distance =
        (point.direction[0] - x) ** 2 + (point.direction[1] - y) ** 2 + (point.direction[2] - z) ** 2;
      if (distance < nearestDistance) {
        nearest = point;
        nearestDistance = distance;
      }
    }
    if (nearest) nearest.overview = true;
  }
  // 同样的卡片大小下，半径按数量的平方根取，球面上单位面积的图片数不随星团大小变化。
  return {
    radius: Math.max(58, clusterCardSide * Math.sqrt(count / (2.2 * Math.PI))),
    overviewRadius: clusterOverviewRadius(count),
    points
  };
}

export type ClusterRing = {
  /** 椭圆的长、短半轴。 */
  major: number;
  minor: number;
  length: number;
  /** 沿椭圆的累计弧长表，用来按弧长取点，保证星团等弧长间隔。 */
  table: { length: number; u: number; v: number }[];
};

export function clusterRing(circumference: number, stretch: number, minimumMinor: number): ClusterRing {
  const unit: { length: number; u: number; v: number }[] = [];
  let unitLength = 0;
  let previousU = stretch;
  let previousV = 0;
  for (let step = 0; step <= 360; step += 1) {
    const t = (step / 360) * Math.PI * 2;
    const u = stretch * Math.cos(t);
    const v = Math.sin(t);
    unitLength += Math.hypot(u - previousU, v - previousV);
    unit.push({ length: unitLength, u, v });
    previousU = u;
    previousV = v;
  }
  const size = Math.max(circumference / unitLength, minimumMinor);
  return {
    major: size * stretch,
    minor: size,
    length: unitLength * size,
    table: unit.map((entry) => ({ length: entry.length * size, u: entry.u * size, v: entry.v * size }))
  };
}

/** 椭圆上弧长 arc 处的点；arc 可以是任意实数，按周长取模。 */
export function clusterRingPoint(ring: ClusterRing, arc: number) {
  const wrapped = ((arc % ring.length) + ring.length) % ring.length;
  let low = 0;
  let high = ring.table.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (ring.table[middle]!.length <= wrapped) low = middle;
    else high = middle;
  }
  const from = ring.table[low]!;
  const to = ring.table[high]!;
  const t = (wrapped - from.length) / Math.max(1e-6, to.length - from.length);
  return { u: from.u + (to.u - from.u) * t, v: from.v + (to.v - from.v) * t };
}

/** 椭圆表中 quarter 个四分之一圈处的弧长：0 = 长轴正端，1 = 短轴正端，以此类推。 */
export function clusterRingQuarterArc(ring: ClusterRing, quarter: number) {
  return ring.table[((quarter % 4) + 4) % 4 * 90]!.length;
}

export type ClusterZoomRange = {
  /** 成像倍数：星团刚好顶满屏幕长边。群内缩放以它为 1.0。 */
  fill: number;
  /** 进入星团时的缩放。 */
  entry: number;
  /** 低于它就回到星群总览：星团刚好填满屏幕短边。 */
  exit: number;
  maximum: number;
};

/**
 * 群内缩放的三个锚点都挂在屏幕上：进入时顶满长边（窗口接近正方形时再保证图片不小于短边的约三成半），
 * 缩到短边填满以下回到总览，放大到最高的图约占视口高度八成为止。
 */
export function clusterZoomRange(options: {
  width: number;
  height: number;
  focalLength: number;
  /** 进入后（已展开）的球半径。 */
  radius: number;
  distance: number;
}): ClusterZoomRange {
  const { width, height, focalLength, radius, distance } = options;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const outline = radius * 0.97;
  const silhouette =
    (focalLength * outline) / Math.sqrt(Math.max(1, distance * distance - outline * outline));
  const fill = long / 2 / Math.max(1, silhouette);
  // 成像倍数为 1 时，正面最高的竖图在屏幕上的高度。
  const frontCard =
    (clusterCardSide * clusterCardGrowth * 1.4 * focalLength) / Math.max(1, distance - radius);
  // 只有几张图的小星团，顶满长边时单张图会比屏幕还大：进入时最高的图不超过视口高度的约六成、短边的四分之三。
  const entryLimit = Math.min(height * 0.62, short * 0.75) / frontCard / fill;
  const entry = Math.min(Math.max(1, (short * 0.35) / frontCard / fill), entryLimit);
  const maximum = Math.max(
    entry * 1.3,
    Math.min(7, Math.max(1.3, (height * 0.8) / frontCard)) / fill
  );
  return { fill, entry, exit: Math.min(short / long, entry * 0.8), maximum };
}
