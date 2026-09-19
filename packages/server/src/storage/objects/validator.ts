import { entityTagDigest } from "../../core/http/validators.ts";

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
  const identity = [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
  return `"l.${entityTagDigest(identity)}"`;
}
