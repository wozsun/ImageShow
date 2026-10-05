export type ReadyImageDerivedResultKind = "attribute" | "filter" | "stats-result";

export const READY_IMAGE_DERIVED_CACHE_POLICY = Object.freeze({
  ttlSeconds: 12 * 60 * 60,
  // A result read again within this interval keeps its earlier TTL refresh and
  // LRU position instead of re-validating the whole registry on every read.
  accessRegistrationIntervalMs: 60_000,
  temporaryTtlSeconds: 5 * 60,
  maxResults: 1024,
  maxResultMembers: 1_000_000,
  minimumTotalMembers: 10_000,
  totalMemberMultiplier: 32,
  maxActiveSignatures: 512,
  maxStatsResultBytes: 1024 * 1024
});
