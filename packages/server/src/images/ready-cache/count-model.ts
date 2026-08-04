import {
  brightnesses,
  devices,
  type Brightness,
  type Device
} from "@imageshow/shared/browser";
import type { ReadyImageFilterPlan } from "./filters.ts";

type CountRecord = Record<string, number>;

export type ReadyImageCountSnapshot = {
  total: number;
  matching: number;
  axes: CountRecord;
  devices: CountRecord;
  brightnesses: CountRecord;
  themes: CountRecord;
  tags: CountRecord;
  authors: CountRecord;
};

export type CachedReadyImageCountSnapshot = {
  revision: string;
  value: ReadyImageCountSnapshot;
};

export const readyImageAxisPairs = devices.flatMap((device) => (
  brightnesses.map((brightness) => ({ device, brightness }))
));

export function nonNegativeReadyImageCount(value: unknown) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function countRecord(value: unknown): value is CountRecord {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value).every(
      (count) => nonNegativeReadyImageCount(count) !== null
    )
  );
}

function validSnapshot(value: unknown): value is ReadyImageCountSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<ReadyImageCountSnapshot>;
  return nonNegativeReadyImageCount(snapshot.total) !== null
    && nonNegativeReadyImageCount(snapshot.matching) !== null
    && countRecord(snapshot.axes)
    && countRecord(snapshot.devices)
    && countRecord(snapshot.brightnesses)
    && countRecord(snapshot.themes)
    && countRecord(snapshot.tags)
    && countRecord(snapshot.authors);
}

export function parseCachedReadyImageCountSnapshot(raw: string | null) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CachedReadyImageCountSnapshot>;
    if (
      !/^\d+$/.test(String(value.revision ?? ""))
      || !validSnapshot(value.value)
    ) {
      return null;
    }
    return value as CachedReadyImageCountSnapshot;
  } catch {
    return null;
  }
}

export function activeReadyImageCounts(
  stats: Map<string, number>,
  prefix: string
) {
  const result: CountRecord = {};
  for (const [field, count] of stats) {
    if (field.startsWith(prefix)) result[field.slice(prefix.length)] = count;
  }
  return result;
}

export function readyImageAxisField(
  device: Device,
  brightness: Brightness
) {
  return `${device}:${brightness}`;
}

function assertGlobalStats(stats: Map<string, number>, expectedTotal: number) {
  const total = stats.get("total");
  if (total !== expectedTotal) {
    throw new Error("Ready-image cache statistics total is inconsistent");
  }
  const axisTotal = readyImageAxisPairs.reduce((sum, axis) => (
    sum + (stats.get(`axis:${axis.device}:${axis.brightness}`) ?? 0)
  ), 0);
  const deviceTotal = devices.reduce((sum, device) => (
    sum + (stats.get(`device:${device}`) ?? 0)
  ), 0);
  const brightnessTotal = brightnesses.reduce((sum, brightness) => (
    sum + (stats.get(`brightness:${brightness}`) ?? 0)
  ), 0);
  const themeTotal = [...stats]
    .filter(([field]) => field.startsWith("theme:"))
    .reduce((sum, [, count]) => sum + count, 0);
  if (
    axisTotal !== total
    || deviceTotal !== total
    || brightnessTotal !== total
    || themeTotal !== total
  ) {
    throw new Error("Ready-image cache statistics dimensions are inconsistent");
  }
}

export function parseReadyImageGlobalStats(
  raw: Record<string, string>,
  expectedTotal: number
) {
  const stats = new Map<string, number>();
  for (const [field, value] of Object.entries(raw)) {
    const count = nonNegativeReadyImageCount(value);
    if (count === null) {
      throw new Error("Ready-image cache contains an invalid statistic");
    }
    stats.set(field, count);
  }
  assertGlobalStats(stats, expectedTotal);
  return stats;
}

export function isUnfilteredReadyImagePlan(plan: ReadyImageFilterPlan) {
  return plan.axes.length === readyImageAxisPairs.length
    && plan.theme.include.length === 0
    && plan.theme.exclude.length === 0
    && plan.tag.include.length === 0
    && plan.tag.exclude.length === 0
    && plan.author.include.length === 0
    && plan.author.exclude.length === 0;
}

export function readyImageCountRecord(
  keys: string[],
  counts: number[]
) {
  return Object.fromEntries(keys.map((key, index) => [
    key,
    counts[index] ?? 0
  ]));
}

export function readyImageSnapshotFromGlobalStats(
  stats: Map<string, number>
) {
  const total = stats.get("total") ?? 0;
  return {
    total,
    matching: total,
    axes: Object.fromEntries(readyImageAxisPairs.map(({ device, brightness }) => [
      readyImageAxisField(device, brightness),
      stats.get(`axis:${device}:${brightness}`) ?? 0
    ])),
    devices: Object.fromEntries(devices.map((device) => [
      device,
      stats.get(`device:${device}`) ?? 0
    ])),
    brightnesses: Object.fromEntries(brightnesses.map((brightness) => [
      brightness,
      stats.get(`brightness:${brightness}`) ?? 0
    ])),
    themes: activeReadyImageCounts(stats, "theme:"),
    tags: activeReadyImageCounts(stats, "tag:"),
    authors: activeReadyImageCounts(stats, "author:")
  } satisfies ReadyImageCountSnapshot;
}
