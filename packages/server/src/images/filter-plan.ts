import {
  brightnesses,
  devices,
  normalizeTagExpression,
  parseGalleryTagFilter,
  assertKnownTags,
  slugMaxLength,
  slugPattern,
  TagFilterError,
  type TagExpression,
  type Brightness,
  type Device
} from "@imageshow/shared/browser";
import { appConfig } from "@imageshow/shared";
import { ApiError } from "../core/api-error.ts";
import type { VocabularyReadAccess } from "../vocab/cache.ts";
import { getTagSlugs } from "../vocab/tags/query.ts";

export type ImageSelectorGroup = {
  include: string[];
  exclude: string[];
};

export type ImageFilterPlan = {
  axes: Array<{ device: Device; brightness: Brightness }>;
  theme: ImageSelectorGroup;
  tag: TagExpression;
  author: ImageSelectorGroup;
  range?: { groups: string[]; ids: string[] };
  signature: string;
};

export type ImageFilterDimension = "device" | "brightness" | "theme" | "tag" | "author";

type ImageFilterInput = {
  device?: Device;
  brightness?: Brightness;
  theme?: string;
  tag?: string | string[];
  author?: string;
};

const IMAGE_FILTER_AXES = devices.flatMap((device) =>
  brightnesses.map((brightness) => ({ device, brightness }))
);

function splitSelectors(rawValues: string[]): { include: string[]; exclude: string[] } {
  const values = [
    ...new Set(
      rawValues
        .flatMap((value) => value.split(","))
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    )
  ];
  if (values.length > appConfig.randomQuery.maxSelectorsPerField) {
    throw new ApiError(
      400,
      "validation_error",
      `Too many selectors; maximum ${appConfig.randomQuery.maxSelectorsPerField}`
    );
  }
  const include: string[] = [];
  const exclude: string[] = [];
  for (const value of values) {
    const excluded = value.startsWith("!");
    const bare = excluded ? value.slice(1).trim() : value;
    if (
      bare.length > slugMaxLength ||
      !slugPattern.test(bare)
    ) {
      throw new ApiError(400, "validation_error", "Invalid image selector");
    }
    (excluded ? exclude : include).push(bare);
  }
  return { include, exclude };
}

function normalizedGroup(
  group: Partial<ImageSelectorGroup> | undefined,
  noun: string
) {
  const include = [...new Set(group?.include ?? [])].sort();
  const exclude = [...new Set(group?.exclude ?? [])].sort();
  if (include.length && exclude.length) {
    throw new ApiError(
      400,
      "validation_error",
      `Cannot mix include and exclude ${noun} selectors`
    );
  }
  return { include, exclude };
}

export function createImageFilterPlan(input: {
  devices?: readonly Device[];
  brightnesses?: readonly Brightness[];
  theme?: Partial<ImageSelectorGroup>;
  tag?: TagExpression;
  author?: Partial<ImageSelectorGroup>;
  range?: { groups: readonly string[]; ids: readonly string[] };
}): ImageFilterPlan {
  const selectedDevices = [...new Set(input.devices ?? devices)].sort();
  const selectedBrightnesses = [
    ...new Set(input.brightnesses ?? brightnesses)
  ].sort();
  const axes = selectedDevices.flatMap((device) =>
    selectedBrightnesses.map((brightness) => ({ device, brightness }))
  );
  const theme = normalizedGroup(input.theme, "theme");
  const tag = input.tag ? normalizeTagExpression(input.tag.anyOf) : null;
  const author = normalizedGroup(input.author, "author");
  const range = input.range ? {
    groups: [...new Set(input.range.groups)].sort(),
    ids: [...new Set(input.range.ids)].sort()
  } : undefined;
  const fields = { axes, theme, tag, author, ...(range ? { range } : {}) };
  return { ...fields, signature: JSON.stringify(fields) };
}

export async function validateImageTagExpressions(
  expressions: readonly TagExpression[],
  access: VocabularyReadAccess = {}
) {
  if (!expressions.some((expression) => expression !== null)) return;
  const slugs = await getTagSlugs(access);
  try {
    for (const expression of expressions) assertKnownTags(expression, slugs);
  } catch (error) {
    if (!(error instanceof TagFilterError)) throw error;
    throw new ApiError(404, "unknown_tag", error.message, { field: "tag", value: error.term });
  }
}

export async function resolveImageFilterPlan(
  input: ImageFilterInput,
  access: VocabularyReadAccess = {}
) {
  let parsedTag: TagExpression;
  try {
    parsedTag = parseGalleryTagFilter(
      input.tag === undefined ? [] : typeof input.tag === "string" ? [input.tag] : input.tag
    ).expression;
  } catch (error) {
    if (!(error instanceof TagFilterError)) throw error;
    throw new ApiError(400, "validation_error", error.message, { field: "tag" });
  }
  const theme = normalizedGroup(splitSelectors(input.theme ? [input.theme] : []), "theme");
  const author = normalizedGroup(splitSelectors(input.author ? [input.author] : []), "author");
  await validateImageTagExpressions([parsedTag], access);
  return createImageFilterPlan({
    devices: input.device ? [input.device] : devices,
    brightnesses: input.brightness ? [input.brightness] : brightnesses,
    theme,
    tag: parsedTag,
    author
  });
}

export function imageFilterPlanWithout(
  plan: ImageFilterPlan,
  dimension: ImageFilterDimension
) {
  const planDevices = [...new Set(plan.axes.map((axis) => axis.device))];
  const planBrightnesses = [...new Set(plan.axes.map((axis) => axis.brightness))];
  return createImageFilterPlan({
    devices: dimension === "device" ? devices : planDevices,
    brightnesses: dimension === "brightness"
      ? brightnesses
      : planBrightnesses,
    theme: dimension === "theme" ? undefined : plan.theme,
    tag: dimension === "tag" ? undefined : plan.tag,
    author: dimension === "author" ? undefined : plan.author,
    range: plan.range
  });
}

export function imageFilterPlanHasAllAxes(plan: ImageFilterPlan) {
  if (plan.axes.length !== IMAGE_FILTER_AXES.length) return false;
  const selected = new Set(plan.axes.map((axis) => `${axis.device}:${axis.brightness}`));
  return IMAGE_FILTER_AXES.every((axis) => selected.has(`${axis.device}:${axis.brightness}`));
}
