function testNamespace() {
  if (process.env.NODE_ENV !== "test") return "";
  const requested = process.env.IMAGESHOW_TEST_NAMESPACE?.trim();
  const suffix = (requested || `process-${process.pid}`)
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 96);
  return suffix ? `:test:${suffix}` : `:test:process-${process.pid}`;
}

export const volatileKeyNamespace = `imageshow${testNamespace()}`;

export function volatileKey(...parts: string[]) {
  return [volatileKeyNamespace, ...parts].join(":");
}
