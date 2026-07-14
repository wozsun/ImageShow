export function normalizeObjectEtag(value: string | null | undefined) {
  const etag = value?.trim() ?? "";
  return /^(?:W\/)?"[^"\r\n]*"$/.test(etag) ? etag : undefined;
}

export function localObjectEtag(stats: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}) {
  return `"local-${stats.dev.toString(16)}-${stats.ino.toString(16)}-${stats.size.toString(16)}-${stats.mtimeNs.toString(16)}-${stats.ctimeNs.toString(16)}"`;
}
