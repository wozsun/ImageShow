import {
  brightnesses,
  devices,
  normalizeTagExpression,
  parseGalleryTagFilter,
  resolveTagExpression,
  TagFilterError,
  type TagExpression,
  type Brightness,
  type Device
} from "@imageshow/shared/browser";
import { resolveAuthorSlugs } from "../authors/query.ts";
import { ApiError } from "../core/api-error.ts";
import { splitSelectors } from "./selectors.ts";
import type { VocabularyReadAccess } from "../vocab/vocab-cache.ts";
import { resolveTagTermMap } from "../tags/query.ts";
import { resolveThemeSlugs } from "../themes/query.ts";

export type ImageSelectorGroup = {
  include: string[];
  exclude: string[];
};

export type ImageFilterPlan = {
  axes: Array<{ device: Device; brightness: Brightness }>;
  theme: ImageSelectorGroup;
  tag: TagExpression;
  author: ImageSelectorGroup;
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

function normalizedGroup(group: Partial<ImageSelectorGroup> | undefined, noun: string) {
  const include = [...new Set(group?.include ?? [])].sort();
  const exclude = [...new Set(group?.exclude ?? [])].sort();
  if (include.length && exclude.length) {
    throw new ApiError(400, "validation_error", `Cannot mix include and exclude ${noun} selectors`);
  }
  return { include, exclude };
}

export function createImageFilterPlan(input: {
  devices?: readonly Device[];
  brightnesses?: readonly Brightness[];
  theme?: Partial<ImageSelectorGroup>;
  tag?: TagExpression;
  author?: Partial<ImageSelectorGroup>;
}): ImageFilterPlan {
  const selectedDevices = [...new Set(input.devices ?? devices)].sort();
  const selectedBrightnesses = [...new Set(input.brightnesses ?? brightnesses)].sort();
  const axes = selectedDevices.flatMap((device) =>
    selectedBrightnesses.map((brightness) => ({ device, brightness }))
  );
  const theme = normalizedGroup(input.theme, "theme");
  const tag = input.tag ? normalizeTagExpression(input.tag.anyOf) : null;
  const author = normalizedGroup(input.author, "author");
  const signature = JSON.stringify({ axes, theme, tag, author });
  return { axes, theme, tag, author, signature };
}

async function resolveSelector(
  raw: string | undefined,
  noun: string,
  resolve: (terms: string[]) => Promise<string[]>
) {
  if (!raw) return normalizedGroup(undefined, noun);
  const selectors = splitSelectors([raw]);
  return normalizedGroup(
    {
      include: await resolve(selectors.include),
      exclude: await resolve(selectors.exclude)
    },
    noun
  );
}

export async function resolveImageTagExpressions(
  expressions: readonly TagExpression[],
  access: VocabularyReadAccess = {}
) {
  const selected = expressions.flatMap((expression) => expression?.anyOf.flat() ?? []);
  if (!selected.length) return expressions.map(() => null);
  const terms = await resolveTagTermMap(selected, access);
  try {
    return expressions.map((expression) => resolveTagExpression(expression, terms));
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
  const [theme, tag, author] = await Promise.all([
    resolveSelector(input.theme, "theme", (terms) => resolveThemeSlugs(terms, access)),
    resolveImageTagExpressions([parsedTag], access).then(([expression]) => expression ?? null),
    resolveSelector(input.author, "author", (terms) => resolveAuthorSlugs(terms, access))
  ]);
  return createImageFilterPlan({
    devices: input.device ? [input.device] : devices,
    brightnesses: input.brightness ? [input.brightness] : brightnesses,
    theme,
    tag,
    author
  });
}

export function imageFilterPlanWithout(plan: ImageFilterPlan, dimension: ImageFilterDimension) {
  const planDevices = [...new Set(plan.axes.map((axis) => axis.device))];
  const planBrightnesses = [...new Set(plan.axes.map((axis) => axis.brightness))];
  return createImageFilterPlan({
    devices: dimension === "device" ? devices : planDevices,
    brightnesses: dimension === "brightness" ? brightnesses : planBrightnesses,
    theme: dimension === "theme" ? undefined : plan.theme,
    tag: dimension === "tag" ? undefined : plan.tag,
    author: dimension === "author" ? undefined : plan.author
  });
}

export function imageFilterPlanHasAllAxes(plan: ImageFilterPlan) {
  if (plan.axes.length !== IMAGE_FILTER_AXES.length) return false;
  const selected = new Set(plan.axes.map((axis) => `${axis.device}:${axis.brightness}`));
  return IMAGE_FILTER_AXES.every((axis) => selected.has(`${axis.device}:${axis.brightness}`));
}
