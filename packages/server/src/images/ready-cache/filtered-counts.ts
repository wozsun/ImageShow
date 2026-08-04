import { brightnesses, devices } from "@imageshow/shared/browser";
import { redis } from "../../core/redis-client.ts";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import {
  resolveReadyImageFilterIndex,
  validateReadyImageFilterIndex,
  type ReadyImageFilterIndex
} from "./filter-index.ts";
import {
  readyImageFilterPlanWithout,
  type ReadyImageFilterPlan
} from "./filters.ts";
import {
  readyImageAxisIndexKey,
  readyImageAuthorIndexKey,
  readyImageTagIndexKey,
  readyImageThemeIndexKey
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
  plans: ReadyImageFilterPlan[]
) {
  const indexes = new Map<string, ReadyImageFilterIndex>();
  for (const plan of plans) {
    if (indexes.has(plan.signature)) continue;
    const index = await resolveReadyImageFilterIndex(plan);
    if (!index) return null;
    indexes.set(plan.signature, index);
  }
  return indexes;
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

export async function buildFilteredReadyImageCountSnapshot(
  plan: ReadyImageFilterPlan,
  indexes: Map<string, ReadyImageFilterIndex>,
  stats: Map<string, number>
) {
  const bySignature = (selected: ReadyImageFilterPlan) => {
    const index = indexes.get(selected.signature);
    if (!index) throw new Error("Ready-image count index was not resolved");
    return index;
  };
  const plans = {
    full: plan,
    device: readyImageFilterPlanWithout(plan, "device"),
    brightness: readyImageFilterPlanWithout(plan, "brightness"),
    theme: readyImageFilterPlanWithout(plan, "theme"),
    tag: readyImageFilterPlanWithout(plan, "tag"),
    author: readyImageFilterPlanWithout(plan, "author")
  };
  const uniqueIndexes = [...new Map(
    Object.values(plans).map((selected) => [
      selected.signature,
      bySignature(selected)
    ])
  ).values()];
  for (const index of uniqueIndexes) {
    const validation = await validateReadyImageFilterIndex(index);
    if (validation !== "valid") return null;
  }

  const axisKeys = readyImageAxisPairs.map(({ device, brightness }) => (
    readyImageAxisIndexKey(device, brightness)
  ));
  const themeSlugs = Object.keys(activeReadyImageCounts(stats, "theme:"));
  const tagSlugs = Object.keys(activeReadyImageCounts(stats, "tag:"));
  const authorSlugs = Object.keys(activeReadyImageCounts(stats, "author:"));
  const [matchingRaw, categories, deviceAxes, brightnessAxes, themes, tags, authors] =
    await Promise.all([
      redis.zcard(bySignature(plans.full).key),
      intersectionCounts(bySignature(plans.full), axisKeys),
      intersectionCounts(bySignature(plans.device), axisKeys),
      intersectionCounts(bySignature(plans.brightness), axisKeys),
      intersectionCounts(
        bySignature(plans.theme),
        themeSlugs.map(readyImageThemeIndexKey)
      ),
      intersectionCounts(
        bySignature(plans.tag),
        tagSlugs.map(readyImageTagIndexKey)
      ),
      intersectionCounts(
        bySignature(plans.author),
        authorSlugs.map(readyImageAuthorIndexKey)
      )
    ]);
  const matching = nonNegativeReadyImageCount(matchingRaw);
  if (matching === null) {
    throw new Error("Redis returned an invalid matching image count");
  }

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
    themes: readyImageCountRecord(themeSlugs, themes),
    tags: readyImageCountRecord(tagSlugs, tags),
    authors: readyImageCountRecord(authorSlugs, authors)
  } satisfies ReadyImageCountSnapshot;
}
