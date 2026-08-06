import { brightnesses, devices } from "@imageshow/shared/browser";
import { logger } from "../../core/logger.ts";
import { redis } from "../../core/redis-client.ts";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import {
  resolveReadyImageFilterIndex,
  validateReadyImageFilterIndex,
  type ReadyImageFilterIndex
} from "./filter-index.ts";
import { ReadyImageCoreCacheError } from "./cache-errors.ts";
import {
  READY_IMAGE_DERIVED_WORK_POLICY,
  assessReadyImageStatsWork,
  tryAcquireReadyImageStatsBuildSlot,
  type ReadyImageDerivedWorkAdmission
} from "./derived-work-policy.ts";
import type { ReadyImageSourceIndexState } from "./attribute-index.ts";
import {
  imageFilterPlanWithout,
  type ImageFilterPlan
} from "../filter-plan.ts";
import {
  readyImageAttributeIndexKey
} from "./keys.ts";
import { REDIS_BATCH_MAX_COMMANDS } from "./redis-batch.ts";
import {
  activeReadyImageCounts,
  nonNegativeReadyImageCount,
  readyImageAxisField,
  readyImageAxisPairs,
  readyImageCountRecord,
  type ReadyImageCountSnapshot
} from "./count-model.ts";

export async function resolveReadyImageCountIndexes(
  plans: ImageFilterPlan[],
  signal?: AbortSignal
) {
  const indexes = new Map<string, ReadyImageFilterIndex>();
  for (const plan of plans) {
    if (indexes.has(plan.signature)) continue;
    const index = await resolveReadyImageFilterIndex(plan, signal);
    if (!index) return null;
    indexes.set(plan.signature, index);
  }
  return indexes;
}

export function readyImageCountAttributeIndexes(stats: Map<string, number>) {
  const axisKeys = readyImageAxisPairs.map(({ device, brightness }) => (
    readyImageAttributeIndexKey({ kind: "axis", device, brightness })
  ));
  const themeSlugs = Object.keys(activeReadyImageCounts(stats, "theme:"));
  const tagSlugs = Object.keys(activeReadyImageCounts(stats, "tag:"));
  const authorSlugs = Object.keys(activeReadyImageCounts(stats, "author:"));
  const themeKeys = themeSlugs.map((value) => (
    readyImageAttributeIndexKey({ kind: "theme", value })
  ));
  const tagKeys = tagSlugs.map((value) => (
    readyImageAttributeIndexKey({ kind: "tag", value })
  ));
  const authorKeys = authorSlugs.map((value) => (
    readyImageAttributeIndexKey({ kind: "author", value })
  ));
  return {
    all: [...axisKeys, ...themeKeys, ...tagKeys, ...authorKeys],
    axisKeys,
    themeKeys,
    tagKeys,
    authorKeys,
    themeSlugs,
    tagSlugs,
    authorSlugs
  };
}

function readyImageDynamicStatsDimensionCount(stats: Map<string, number>) {
  let count = 0;
  for (const field of stats.keys()) {
    if (
      !field.startsWith("theme:")
      && !field.startsWith("tag:")
      && !field.startsWith("author:")
    ) {
      continue;
    }
    count += 1;
    if (count > READY_IMAGE_DERIVED_WORK_POLICY.maxDynamicStatsDimensions) {
      return count;
    }
  }
  return count;
}

export function readyImageCountFilterPlans(plan: ImageFilterPlan) {
  return {
    full: plan,
    device: imageFilterPlanWithout(plan, "device"),
    brightness: imageFilterPlanWithout(plan, "brightness"),
    theme: imageFilterPlanWithout(plan, "theme"),
    tag: imageFilterPlanWithout(plan, "tag"),
    author: imageFilterPlanWithout(plan, "author")
  };
}

function readyImageFilterCountUpperBound(
  plan: ImageFilterPlan,
  stats: Map<string, number>
) {
  const total = stats.get("total") ?? 0;
  const positiveBounds: number[] = [];
  if (plan.axes.length < readyImageAxisPairs.length) {
    positiveBounds.push(plan.axes.reduce((sum, { device, brightness }) => (
      sum + (stats.get(`axis:${device}:${brightness}`) ?? 0)
    ), 0));
  }
  for (const [group, prefix] of [
    [plan.theme, "theme:"],
    [plan.tag, "tag:"],
    [plan.author, "author:"]
  ] as const) {
    if (!group.include.length) continue;
    positiveBounds.push(group.include.reduce((sum, slug) => (
      sum + (stats.get(`${prefix}${slug}`) ?? 0)
    ), 0));
  }
  return positiveBounds.length
    ? Math.min(total, ...positiveBounds)
    : total;
}

function readyImageCandidateCounts(
  stats: Map<string, number>,
  candidates: ReturnType<typeof readyImageCountAttributeIndexes>
) {
  const counts = new Map<string, number>();
  readyImageAxisPairs.forEach(({ device, brightness }, index) => {
    counts.set(
      candidates.axisKeys[index]!,
      stats.get(`axis:${device}:${brightness}`) ?? 0
    );
  });
  for (const [keys, slugs, prefix] of [
    [candidates.themeKeys, candidates.themeSlugs, "theme:"],
    [candidates.tagKeys, candidates.tagSlugs, "tag:"],
    [candidates.authorKeys, candidates.authorSlugs, "author:"]
  ] as const) {
    keys.forEach((key, index) => {
      counts.set(key, stats.get(`${prefix}${slugs[index]}`) ?? 0);
    });
  }
  return counts;
}

function readyImageStatsWorkIntersections(
  plans: ReturnType<typeof readyImageCountFilterPlans>,
  candidates: ReturnType<typeof readyImageCountAttributeIndexes>,
  baseCount: (plan: ImageFilterPlan) => number,
  candidateCount: (key: string) => number
) {
  return [
    { plan: plans.full, keys: candidates.axisKeys },
    { plan: plans.device, keys: candidates.axisKeys },
    { plan: plans.brightness, keys: candidates.axisKeys },
    { plan: plans.theme, keys: candidates.themeKeys },
    { plan: plans.tag, keys: candidates.tagKeys },
    { plan: plans.author, keys: candidates.authorKeys }
  ].flatMap(({ plan: selected, keys }) => keys.map((key) => ({
    baseCount: baseCount(selected),
    candidateCount: candidateCount(key)
  })));
}

export function preflightReadyImageCountSnapshotWork(
  plan: ImageFilterPlan,
  stats: Map<string, number>
):
  | {
    admission: Extract<ReadyImageDerivedWorkAdmission, { admitted: false }>;
  }
  | {
    admission: Extract<ReadyImageDerivedWorkAdmission, { admitted: true }>;
    candidates: ReturnType<typeof readyImageCountAttributeIndexes>;
    plans: ReturnType<typeof readyImageCountFilterPlans>;
  } {
  const dynamicDimensions = readyImageDynamicStatsDimensionCount(stats);
  const dimensionAdmission = assessReadyImageStatsWork({
    dynamicDimensions,
    intersections: []
  });
  if (!dimensionAdmission.admitted) {
    return { admission: dimensionAdmission };
  }
  const plans = readyImageCountFilterPlans(plan);
  const candidates = readyImageCountAttributeIndexes(stats);
  const candidateCounts = readyImageCandidateCounts(stats, candidates);
  const admission = assessReadyImageStatsWork({
    dynamicDimensions,
    intersections: readyImageStatsWorkIntersections(
      plans,
      candidates,
      (selected) => readyImageFilterCountUpperBound(selected, stats),
      (key) => candidateCounts.get(key) ?? 0
    )
  });
  return admission.admitted
    ? { admission, candidates, plans }
    : { admission };
}

async function intersectionCounts(
  base: ReadyImageFilterIndex,
  candidateKeys: string[]
) {
  const counts: number[] = [];
  for (
    let offset = 0;
    offset < candidateKeys.length;
    offset += REDIS_BATCH_MAX_COMMANDS
  ) {
    const keys = candidateKeys.slice(offset, offset + REDIS_BATCH_MAX_COMMANDS);
    const pipeline = redis.pipeline();
    for (const key of keys) {
      pipeline.call("ZINTERCARD", "2", base.key, key);
    }
    const results = await execRedisPipeline(pipeline);
    for (const result of results) {
      const count = nonNegativeReadyImageCount(result[1]);
      if (count === null) {
        throw new Error("Redis returned an invalid image intersection count");
      }
      counts.push(count);
    }
  }
  return counts;
}

async function settleReadyImageStatsWork<
  const T extends readonly unknown[]
>(tasks: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const settled = await Promise.allSettled(tasks);
  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  return settled.map((result) => (
    result.status === "fulfilled" ? result.value : undefined
  )) as unknown as T;
}

export async function buildFilteredReadyImageCountSnapshot(
  plan: ImageFilterPlan,
  indexes: Map<string, ReadyImageFilterIndex>,
  stats: Map<string, number>,
  sourceStates: Map<string, ReadyImageSourceIndexState>
) {
  const bySignature = (selected: ImageFilterPlan) => {
    const index = indexes.get(selected.signature);
    if (!index) throw new Error("Ready-image count index was not resolved");
    return index;
  };
  const plans = readyImageCountFilterPlans(plan);
  const uniqueIndexes = [...new Map(
    Object.values(plans).map((selected) => [
      selected.signature,
      bySignature(selected)
    ])
  ).values()];
  const dynamicDimensions = readyImageDynamicStatsDimensionCount(stats);
  const dimensionAdmission = assessReadyImageStatsWork({
    dynamicDimensions,
    intersections: []
  });
  if (!dimensionAdmission.admitted) {
    logger.debug("ready_image_stats_work_rejected", {
      signature: plan.signature,
      phase: "resolved",
      reason: dimensionAdmission.reason,
      ...dimensionAdmission.estimate
    });
    return null;
  }
  const candidates = readyImageCountAttributeIndexes(stats);
  const admission = assessReadyImageStatsWork({
    dynamicDimensions,
    intersections: readyImageStatsWorkIntersections(
      plans,
      candidates,
      (selected) => bySignature(selected).count,
      (key) => sourceStates.get(key)?.count ?? -1
    )
  });
  if (!admission.admitted) {
    logger.debug("ready_image_stats_work_rejected", {
      signature: plan.signature,
      phase: "resolved",
      reason: admission.reason,
      ...admission.estimate
    });
    return null;
  }
  const releaseBuildSlot = tryAcquireReadyImageStatsBuildSlot(
    admission.estimate
  );
  if (!releaseBuildSlot) return null;
  const indexesRemainValid = async () => {
    for (const index of uniqueIndexes) {
      const validation = await validateReadyImageFilterIndex(index);
      if (validation === "revision_changed") return false;
      if (validation === "invalid") {
        if (index.kind === "core") {
          throw new ReadyImageCoreCacheError(
            "Ready-image core index validation failed"
          );
        }
        return false;
      }
    }
    return true;
  };
  try {
    if (!await indexesRemainValid()) return null;

    const [
      matchingRaw,
      categories,
      deviceAxes,
      brightnessAxes,
      themes,
      tags,
      authors
    ] = await settleReadyImageStatsWork([
      redis.zcard(bySignature(plans.full).key),
      intersectionCounts(bySignature(plans.full), candidates.axisKeys),
      intersectionCounts(bySignature(plans.device), candidates.axisKeys),
      intersectionCounts(bySignature(plans.brightness), candidates.axisKeys),
      intersectionCounts(bySignature(plans.theme), candidates.themeKeys),
      intersectionCounts(bySignature(plans.tag), candidates.tagKeys),
      intersectionCounts(bySignature(plans.author), candidates.authorKeys)
    ] as const);
    const matching = nonNegativeReadyImageCount(matchingRaw);
    if (matching === null) {
      throw new Error("Redis returned an invalid matching image count");
    }
    if (!await indexesRemainValid()) return null;

    const axes = readyImageCountRecord(
      readyImageAxisPairs.map(({ device, brightness }) => (
        readyImageAxisField(device, brightness)
      )),
      categories
    );
    const deviceCounts = Object.fromEntries(devices.map((device) => [
      device,
      readyImageAxisPairs.reduce((sum, axis, index) => (
        axis.device === device ? sum + (deviceAxes[index] ?? 0) : sum
      ), 0)
    ]));
    const brightnessCounts = Object.fromEntries(brightnesses.map((brightness) => [
      brightness,
      readyImageAxisPairs.reduce((sum, axis, index) => (
        axis.brightness === brightness
          ? sum + (brightnessAxes[index] ?? 0)
          : sum
      ), 0)
    ]));
    return {
      total: stats.get("total") ?? 0,
      matching,
      axes,
      devices: deviceCounts,
      brightnesses: brightnessCounts,
      themes: readyImageCountRecord(candidates.themeSlugs, themes),
      tags: readyImageCountRecord(candidates.tagSlugs, tags),
      authors: readyImageCountRecord(candidates.authorSlugs, authors)
    } satisfies ReadyImageCountSnapshot;
  } finally {
    releaseBuildSlot();
  }
}
