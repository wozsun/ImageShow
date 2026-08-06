export type ReadyImageDerivedResultKind =
  | "attribute"
  | "filter"
  | "stats-result";

export const READY_IMAGE_DERIVED_CACHE_POLICY = Object.freeze({
  ttlSeconds: 6 * 60 * 60,
  temporaryTtlSeconds: 5 * 60,
  maxResults: 256,
  maxResultMembers: 250_000,
  minimumTotalMembers: 10_000,
  totalMemberMultiplier: 8,
  maxActiveSignatures: 128,
  maxStatsResultBytes: 512 * 1024
});
