import { readyImageFilterOperations } from "./filter-operations.ts";

export const READY_IMAGE_DERIVED_WORK_POLICY = Object.freeze({
  maxMaterializedSourceMembersPerOperation: 200_000,
  maxCardinalitySourceMembersPerOperation: 200_000,
  maxSourceMembersPerFilterBuild: 300_000,
  maxExpectedResultMembers: 100_000,
  maxSetOperationOperands: 8,
  maxSetOperationsPerFilterBuild: 12,
  maxIntersectionDifferenceOperations: 8,
  maxDynamicStatsDimensions: 64,
  maxStatsSourceMembers: 2_000_000,
  maxStatsExpectedMembers: 500_000,
  maxConcurrentFilterBuilds: 4,
  maxConcurrentLargeFilterBuilds: 1,
  largeFilterSourceMembers: 100_000,
  maxConcurrentStatsBuilds: 2,
  maxConcurrentLargeStatsBuilds: 1,
  largeStatsExpectedMembers: 250_000
});

export type ReadyImageDerivedWorkEstimate = {
  operationCount: number;
  intersectionDifferenceOperations: number;
  totalSourceMembers: number;
  peakSourceMembers: number;
  totalExpectedMembers: number;
  peakExpectedMembers: number;
  peakOperands: number;
};

export type ReadyImageDerivedWorkAdmission =
  | { admitted: true; estimate: ReadyImageDerivedWorkEstimate }
  | {
    admitted: false;
    estimate: ReadyImageDerivedWorkEstimate;
    reason: string;
  };

type SetOperationEstimate = {
  kind: "union" | "intersection" | "difference";
  sourceCounts: number[];
  expectedMembers: number;
};

function emptyEstimate(): ReadyImageDerivedWorkEstimate {
  return {
    operationCount: 0,
    intersectionDifferenceOperations: 0,
    totalSourceMembers: 0,
    peakSourceMembers: 0,
    totalExpectedMembers: 0,
    peakExpectedMembers: 0,
    peakOperands: 0
  };
}

function safeMemberCount(count: number) {
  return Number.isSafeInteger(count) && count >= 0;
}

function summarizeOperations(operations: SetOperationEstimate[]) {
  const estimate = emptyEstimate();
  for (const operation of operations) {
    const sourceMembers = operation.sourceCounts.reduce(
      (total, count) => total + count,
      0
    );
    estimate.operationCount += 1;
    if (operation.kind !== "union") {
      estimate.intersectionDifferenceOperations += 1;
    }
    estimate.totalSourceMembers += sourceMembers;
    estimate.peakSourceMembers = Math.max(
      estimate.peakSourceMembers,
      sourceMembers
    );
    estimate.totalExpectedMembers += operation.expectedMembers;
    estimate.peakExpectedMembers = Math.max(
      estimate.peakExpectedMembers,
      operation.expectedMembers
    );
    estimate.peakOperands = Math.max(
      estimate.peakOperands,
      operation.sourceCounts.length
    );
  }
  return estimate;
}

function rejected(
  estimate: ReadyImageDerivedWorkEstimate,
  reason: string
): ReadyImageDerivedWorkAdmission {
  return { admitted: false, estimate, reason };
}

export function assessReadyImageFilterWork(input: {
  itemCount: number;
  positive: number[][];
  tagClauses?: number[][];
  exclusions: number[][];
}): ReadyImageDerivedWorkAdmission {
  const { itemCount, positive, tagClauses = [], exclusions } = input;
  const groups = [...positive, ...tagClauses, ...exclusions];
  if (
    !safeMemberCount(itemCount)
    || groups.some((counts) => counts.some((count) => !safeMemberCount(count)))
  ) {
    return rejected(emptyEstimate(), "invalid_member_count");
  }
  let sequence = 0;
  const nextKey = () => String(sequence++);
  const sources = (groups: number[][]) => groups.map((counts) => counts.map((count) => ({ key: nextKey(), count })));
  const plan = readyImageFilterOperations({
    all: { key: nextKey(), count: itemCount },
    positive: sources(positive),
    tagClauses: sources(tagClauses),
    exclusions: sources(exclusions)
  }, nextKey);
  const operations = plan.operations.map(({ kind, sources, result }) => ({
    kind, sourceCounts: sources.map((source) => source.count), expectedMembers: result.count
  }));

  const estimate = summarizeOperations(operations);
  const policy = READY_IMAGE_DERIVED_WORK_POLICY;
  if (estimate.peakOperands > policy.maxSetOperationOperands) {
    return rejected(estimate, "set_operation_operands");
  }
  if (
    estimate.peakSourceMembers
      > policy.maxMaterializedSourceMembersPerOperation
  ) {
    return rejected(estimate, "operation_source_members");
  }
  if (estimate.totalSourceMembers > policy.maxSourceMembersPerFilterBuild) {
    return rejected(estimate, "filter_source_members");
  }
  if (estimate.peakExpectedMembers > policy.maxExpectedResultMembers) {
    return rejected(estimate, "expected_result_members");
  }
  if (estimate.operationCount > policy.maxSetOperationsPerFilterBuild) {
    return rejected(estimate, "set_operation_count");
  }
  if (
    estimate.intersectionDifferenceOperations
      > policy.maxIntersectionDifferenceOperations
  ) {
    return rejected(estimate, "intersection_difference_operations");
  }
  return { admitted: true, estimate };
}

export function assessReadyImageStatsWork(input: {
  dynamicDimensions: number;
  intersections: Array<{ baseCount: number; candidateCount: number }>;
}): ReadyImageDerivedWorkAdmission {
  const { dynamicDimensions, intersections } = input;
  if (
    !safeMemberCount(dynamicDimensions)
    || intersections.some(({ baseCount, candidateCount }) => (
      !safeMemberCount(baseCount) || !safeMemberCount(candidateCount)
    ))
  ) {
    return rejected(emptyEstimate(), "invalid_member_count");
  }
  const operations = intersections.map(({ baseCount, candidateCount }) => ({
    kind: "intersection" as const,
    sourceCounts: [baseCount, candidateCount],
    expectedMembers: Math.min(baseCount, candidateCount)
  }));
  const estimate = summarizeOperations(operations);
  const policy = READY_IMAGE_DERIVED_WORK_POLICY;
  if (dynamicDimensions > policy.maxDynamicStatsDimensions) {
    return rejected(estimate, "dynamic_stats_dimensions");
  }
  if (estimate.peakOperands > policy.maxSetOperationOperands) {
    return rejected(estimate, "set_operation_operands");
  }
  if (
    estimate.peakSourceMembers
      > policy.maxCardinalitySourceMembersPerOperation
  ) {
    return rejected(estimate, "operation_source_members");
  }
  if (estimate.peakExpectedMembers > policy.maxExpectedResultMembers) {
    return rejected(estimate, "expected_result_members");
  }
  if (estimate.totalSourceMembers > policy.maxStatsSourceMembers) {
    return rejected(estimate, "stats_source_members");
  }
  if (estimate.totalExpectedMembers > policy.maxStatsExpectedMembers) {
    return rejected(estimate, "stats_expected_members");
  }
  return { admitted: true, estimate };
}

let activeFilterBuilds = 0;
let activeLargeFilterBuilds = 0;
let activeStatsBuilds = 0;
let activeLargeStatsBuilds = 0;

function slotRelease(release: () => void) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

export function tryAcquireReadyImageFilterBuildSlot(
  estimate: ReadyImageDerivedWorkEstimate
) {
  const policy = READY_IMAGE_DERIVED_WORK_POLICY;
  const large = estimate.totalSourceMembers >= policy.largeFilterSourceMembers;
  if (
    activeFilterBuilds >= policy.maxConcurrentFilterBuilds
    || (large
      && activeLargeFilterBuilds >= policy.maxConcurrentLargeFilterBuilds)
  ) {
    return null;
  }
  activeFilterBuilds += 1;
  if (large) activeLargeFilterBuilds += 1;
  return slotRelease(() => {
    activeFilterBuilds -= 1;
    if (large) activeLargeFilterBuilds -= 1;
  });
}

export function tryAcquireReadyImageStatsBuildSlot(
  estimate: ReadyImageDerivedWorkEstimate
) {
  const policy = READY_IMAGE_DERIVED_WORK_POLICY;
  const large = estimate.totalExpectedMembers >= policy.largeStatsExpectedMembers;
  if (
    activeStatsBuilds >= policy.maxConcurrentStatsBuilds
    || (large
      && activeLargeStatsBuilds >= policy.maxConcurrentLargeStatsBuilds)
  ) {
    return null;
  }
  activeStatsBuilds += 1;
  if (large) activeLargeStatsBuilds += 1;
  return slotRelease(() => {
    activeStatsBuilds -= 1;
    if (large) activeLargeStatsBuilds -= 1;
  });
}
