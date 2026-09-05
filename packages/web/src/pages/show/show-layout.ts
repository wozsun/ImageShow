import {
  showOrders,
  type ImageCardBaseDto,
  type ShowOrder
} from "@imageshow/shared/browser";

export const showLayoutColumnWidth = 360;

export type ShowImage = ImageCardBaseDto & {
  object_url?: string;
};

export type ShowPoint = {
  x: number;
  y: number;
};

export type ShowSize = {
  width: number;
  height: number;
};

export type ShowRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type ShowViewportWindow = {
  visible: ShowRect;
  resident: ShowRect;
};

export type ShowCardGeometry = {
  x: number;
  width: number;
  height: number;
  gapAfter: number;
  angle: number;
  depth: number;
};

export type ShowCardSlot = ShowCardGeometry & {
  key: string;
  column: number;
  ordinal: number;
  y: number;
  image: ShowImage;
  visible: boolean;
};

function finitePositive(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function nextShowOrder(order: ShowOrder): ShowOrder {
  const index = showOrders.indexOf(order);
  return showOrders[(index + 1) % showOrders.length];
}

export type { ShowOrder };

function showImageAspectRatio(image: ShowImage) {
  const width = finitePositive(image.width, 16);
  const height = finitePositive(image.height, 9);
  return width / height;
}

/** Stable noise for geometry only; image ordering remains owned by the pool. */
export function showLayoutNoise(column: number, ordinal: number, salt: number) {
  const raw = Math.sin(
    column * 127.1
    + ordinal * 311.7
    + salt * 74.7
  ) * 43_758.5453;
  return raw - Math.floor(raw);
}

export function showCardGeometry(
  image: ShowImage,
  column: number,
  ordinal: number,
  columnWidth = showLayoutColumnWidth
): ShowCardGeometry {
  const safeColumnWidth = finitePositive(columnWidth, showLayoutColumnWidth);
  const width = safeColumnWidth * (
    0.985 + showLayoutNoise(column, ordinal, 1) * 0.007
  );
  const horizontalJitter = Math.min(0.2, safeColumnWidth * 0.0015);
  const centeredOffset = (safeColumnWidth - width) / 2;
  return {
    x: column * safeColumnWidth
      + centeredOffset
      + (showLayoutNoise(column, ordinal, 2) - 0.5) * horizontalJitter * 2,
    width,
    height: width / showImageAspectRatio(image),
    // Keep the world seam compact because the normal plane can exceed 2x at
    // wide breakpoints; the visible gap remains below Gallery's own gutter.
    gapAfter: 4 + showLayoutNoise(column, ordinal, 3) * 2,
    // Stable cards stay almost upright. The stronger tilt belongs to the
    // temporary hover preview and does not inflate every compositor surface.
    angle: (showLayoutNoise(column, ordinal, 4) - 0.5) * 0.5,
    depth: 1 + Math.floor(showLayoutNoise(column, ordinal, 5) * 5)
  };
}

export function showRectsIntersect(a: ShowRect, b: ShowRect) {
  return a.right > b.left
    && a.left < b.right
    && a.bottom > b.top
    && a.top < b.bottom;
}

export function showCardRect(card: Pick<ShowCardSlot, "x" | "y" | "width" | "height">): ShowRect {
  return {
    left: card.x,
    top: card.y,
    right: card.x + card.width,
    bottom: card.y + card.height
  };
}

export type ShowResidencePolicy = {
  horizontalOverscanScreens: number;
  verticalOverscanScreens: number;
};

export function showViewportWindow(
  camera: ShowPoint,
  viewport: ShowSize,
  scale: number,
  residence: ShowResidencePolicy
): ShowViewportWindow {
  const safeScale = finitePositive(scale, 1);
  const width = Math.max(1, finitePositive(viewport.width, 1)) / safeScale;
  const height = Math.max(1, finitePositive(viewport.height, 1)) / safeScale;
  const left = camera.x / safeScale;
  const top = camera.y / safeScale;
  const visible = {
    left,
    top,
    right: left + width,
    bottom: top + height
  };
  const horizontalOverscan = Math.max(
    0,
    residence.horizontalOverscanScreens
  );
  const verticalOverscan = Math.max(0, residence.verticalOverscanScreens);
  return {
    visible,
    resident: {
      left: left - width * horizontalOverscan,
      top: top - height * verticalOverscan,
      right: visible.right + width * horizontalOverscan,
      bottom: visible.bottom + height * verticalOverscan
    }
  };
}
