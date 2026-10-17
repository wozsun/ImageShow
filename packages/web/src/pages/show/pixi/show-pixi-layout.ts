import { galleryColumnCount } from "../../../lib/gallery/gallery-columns.js";

export type ShowWaterfallDensity = {
  galleryColumns: number;
  minimumColumns: number;
  defaultColumns: number;
  normalMaximumColumns: number;
  warningColumns: number;
  maximumColumns: number;
};

export const showWaterfallDensity = (viewportWidth: number): ShowWaterfallDensity => {
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0
    ? viewportWidth
    : 360;
  const galleryColumns = galleryColumnCount(width);
  return {
    galleryColumns,
    minimumColumns: Math.max(0.5, galleryColumns * 0.5),
    defaultColumns: galleryColumns,
    normalMaximumColumns: galleryColumns * 1.5,
    warningColumns: galleryColumns * 3,
    maximumColumns: galleryColumns * 8
  };
};

export const clampShowWaterfallColumns = (
  columns: number,
  density: ShowWaterfallDensity
) =>
  Math.min(
    density.maximumColumns,
    Math.max(density.minimumColumns, columns)
  );

export const smallerShowWaterfallImages = (
  columns: number,
  density: ShowWaterfallDensity
) =>
  clampShowWaterfallColumns(columns + 1, density);

export const largerShowWaterfallImages = (
  columns: number,
  density: ShowWaterfallDensity
) =>
  clampShowWaterfallColumns(columns - 1, density);

/** Float size steps; the default is the middle one. */
export const showFloatSizeStepCount = 11;

export const defaultShowFloatSizeIndex = 5;

export const clampShowFloatSizeIndex = (index: number) =>
  Math.min(
    showFloatSizeStepCount - 1,
    Math.max(0, Math.round(index))
  );

/** Viewport height kept free around a float card so all of it can be viewed. */
export const showFloatViewingMargin = 128;

const floatViewport = (viewportWidth: number, viewportHeight: number) => ({
  width: Number.isFinite(viewportWidth) && viewportWidth > 0
    ? viewportWidth
    : 360,
  height: Number.isFinite(viewportHeight) && viewportHeight > 0
    ? viewportHeight
    : 640
});

/**
 * Card side (square root of the card area) at the default size step. Float
 * cards share the cluster's equal-area rule, a little larger than its
 * on-screen cards, so an image's aspect changes its shape rather than its
 * visual weight. Narrow screens keep a minimum side, at most 40% of their
 * width: by area alone a phone card would be about a quarter of the screen
 * width, too small to view.
 */
const floatDefaultCardSide = (width: number, height: number) =>
  Math.max(Math.sqrt(width * height) * 0.23, Math.min(150, width * 0.4));

/**
 * Card side at a size step. Steps change the side by an even ratio, down to
 * half the default and up to the largest size: about two cards across the
 * viewport, while a portrait card still fits the height left for viewing.
 */
export const showFloatStepSide = (
  index: number,
  viewportWidth: number,
  viewportHeight: number
) => {
  const { width, height } = floatViewport(viewportWidth, viewportHeight);
  const side = floatDefaultCardSide(width, height);
  const offset = clampShowFloatSizeIndex(index) - defaultShowFloatSizeIndex;
  if (offset < 0) return side * 0.5 ** (-offset / defaultShowFloatSizeIndex);
  // A 2:3 portrait card is about 1.22 sides tall; the extra keeps its
  // rotation within the height left for viewing.
  const largest = Math.max(
    side,
    Math.min(width * 0.6, (height - showFloatViewingMargin) / 1.25)
  );
  const steps = showFloatSizeStepCount - 1 - defaultShowFloatSizeIndex;
  return side * (largest / side) ** (offset / steps);
};

/** Float stream density: card area per unit of stream area. */
export const showFloatPacking = 0.8;
