import {
  brightnesses,
  devices,
  slugMaxLength,
  slugPattern,
  type Brightness,
  type Device
} from "@imageshow/shared/browser";
import type { ImageFilterPlan } from "../filter-plan.ts";

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

function jsonReadyImageCount(value: unknown) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

function countRecord(value: unknown): value is CountRecord {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value).every(
      (count) => jsonReadyImageCount(count) !== null
    )
  );
}

function exactCountRecord(
  value: unknown,
  expectedKeys: readonly string[],
  maximum: number
): value is CountRecord {
  if (!countRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && Object.values(value).every((count) => count <= maximum);
}

function boundedCountRecord(
  value: unknown,
  maximum: number
): value is CountRecord {
  return countRecord(value)
    && Object.values(value).every((count) => count <= maximum)
    && Object.keys(value).every((key) => (
      key.length <= slugMaxLength
      && slugPattern.test(key)
    ));
}

function safeCountSum(record: CountRecord) {
  const sum = Object.values(record).reduce((total, count) => total + count, 0);
  return Number.isSafeInteger(sum) ? sum : null;
}

function countSumWithin(
  record: CountRecord,
  minimum: number,
  maximum: number
) {
  const sum = safeCountSum(record);
  return sum !== null && sum >= minimum && sum <= maximum;
}

function validSnapshot(value: unknown): value is ReadyImageCountSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<ReadyImageCountSnapshot>;
  const total = jsonReadyImageCount(snapshot.total);
  const matching = jsonReadyImageCount(snapshot.matching);
  const axisKeys = readyImageAxisPairs.map(({ device, brightness }) => (
    readyImageAxisField(device, brightness)
  ));
  const expectedFields = [
    "total",
    "matching",
    "axes",
    "devices",
    "brightnesses",
    "themes",
    "tags",
    "authors"
  ].sort();
  const actualFields = Object.keys(snapshot).sort();
  if (
    actualFields.length !== expectedFields.length
    || actualFields.some((field, index) => field !== expectedFields[index])
    || total === null
    || matching === null
    || matching > total
    || !exactCountRecord(snapshot.axes, axisKeys, total)
    || !exactCountRecord(snapshot.devices, devices, total)
    || !exactCountRecord(snapshot.brightnesses, brightnesses, total)
    || !boundedCountRecord(snapshot.themes, total)
    || !boundedCountRecord(snapshot.tags, total)
    || !boundedCountRecord(snapshot.authors, total)
  ) {
    return false;
  }
  return safeCountSum(snapshot.axes) === matching
    && countSumWithin(snapshot.devices, matching, total)
    && countSumWithin(snapshot.brightnesses, matching, total)
    && countSumWithin(snapshot.themes, matching, total)
    && countSumWithin(snapshot.authors, 0, total);
}

export function parseCachedReadyImageCountSnapshot(raw: string | null) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CachedReadyImageCountSnapshot>;
    if (
      Object.keys(value).length !== 2
      || typeof value.revision !== "string"
      || !/^\d+$/.test(value.revision)
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
  const authorTotal = [...stats]
    .filter(([field]) => field.startsWith("author:"))
    .reduce((sum, [, count]) => sum + count, 0);
  const validFixedFields = new Set([
    "total",
    ...readyImageAxisPairs.map(({ device, brightness }) => (
      `axis:${device}:${brightness}`
    )),
    ...devices.map((device) => `device:${device}`),
    ...brightnesses.map((brightness) => `brightness:${brightness}`)
  ]);
  const validDynamicField = (field: string) => {
    const separator = field.indexOf(":");
    const prefix = field.slice(0, separator);
    const slug = field.slice(separator + 1);
    return (prefix === "theme" || prefix === "tag" || prefix === "author")
      && slug.length <= slugMaxLength
      && slugPattern.test(slug);
  };
  if (
    [...stats].some(([field, count]) => (
      count > expectedTotal
      || (!validFixedFields.has(field) && !validDynamicField(field))
    ))
    || axisTotal !== total
    || deviceTotal !== total
    || brightnessTotal !== total
    || themeTotal !== total
    || authorTotal > total
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
    const numeric = /^\d+$/u.test(value) ? Number(value) : null;
    const count = numeric !== null && Number.isSafeInteger(numeric)
      ? numeric
      : null;
    if (count === null) {
      throw new Error("Ready-image cache contains an invalid statistic");
    }
    stats.set(field, count);
  }
  assertGlobalStats(stats, expectedTotal);
  return stats;
}

export function isUnfilteredReadyImagePlan(plan: ImageFilterPlan) {
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
