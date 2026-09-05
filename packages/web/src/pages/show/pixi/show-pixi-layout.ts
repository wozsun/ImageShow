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
) => Math.min(
  density.maximumColumns,
  Math.max(density.minimumColumns, columns)
);

export const smallerShowWaterfallImages = (
  columns: number,
  density: ShowWaterfallDensity
) => clampShowWaterfallColumns(columns + 1, density);

export const largerShowWaterfallImages = (
  columns: number,
  density: ShowWaterfallDensity
) => clampShowWaterfallColumns(columns - 1, density);

export const showFloatSizeSteps = [
  0.5,
  0.6,
  0.7,
  0.8,
  0.9,
  1,
  1.1,
  1.2,
  1.3,
  1.4,
  1.5
] as const;

export const defaultShowFloatSizeIndex = 5;

export const showFloatDefaultWidth = (viewportWidth: number) => {
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0
    ? viewportWidth
    : 360;
  return width / showWaterfallDensity(width).defaultColumns * 0.8;
};

export const clampShowFloatSizeIndex = (index: number) => Math.min(
  showFloatSizeSteps.length - 1,
  Math.max(0, Math.round(index))
);
