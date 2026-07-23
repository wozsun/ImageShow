const galleryBreakpoints = { single: 359, double: 760, triple: 1080 } as const;
const galleryWideColumnTargetWidth = 440;
const galleryMaxColumns = 8;

export function galleryColumnCount(width: number) {
  if (width <= galleryBreakpoints.single) return 1;
  if (width <= galleryBreakpoints.double) return 2;
  if (width <= galleryBreakpoints.triple) return 3;
  return Math.min(
    galleryMaxColumns,
    Math.max(4, Math.ceil(width / galleryWideColumnTargetWidth))
  );
}
