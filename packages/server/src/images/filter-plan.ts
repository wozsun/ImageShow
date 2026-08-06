import {
  brightnesses,
  devices,
  type Brightness,
  type Device
} from "@imageshow/shared/browser";
import { resolveAuthorSlugs } from "../authors/query.ts";
import { ApiError } from "../core/api-error.ts";
import { splitSelectors } from "../core/selectors.ts";
import { resolveTagNames } from "../tags/query.ts";
import { resolveThemeSlugs } from "../themes/query.ts";

export type ImageSelectorGroup = {
  include: string[];
  exclude: string[];
};

export type ImageFilterPlan = {
  axes: Array<{ device: Device; brightness: Brightness }>;
  theme: ImageSelectorGroup;
  tag: ImageSelectorGroup;
  author: ImageSelectorGroup;
  signature: string;
};

export type ImageFilterDimension =
  | "device"
  | "brightness"
  | "theme"
  | "tag"
  | "author";

type ImageFilterInput = {
  d?: Device;
  b?: Brightness;
  t?: string;
  tag?: string;
  a?: string;
};

const IMAGE_FILTER_AXES = devices.flatMap((device) => (
  brightnesses.map((brightness) => ({ device, brightness }))
));

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
  tag?: Partial<ImageSelectorGroup>;
  author?: Partial<ImageSelectorGroup>;
}): ImageFilterPlan {
  const selectedDevices = [...new Set(input.devices ?? devices)].sort();
  const selectedBrightnesses = [
    ...new Set(input.brightnesses ?? brightnesses)
  ].sort();
  const axes = selectedDevices.flatMap((device) => (
    selectedBrightnesses.map((brightness) => ({ device, brightness }))
  ));
  const theme = normalizedGroup(input.theme, "theme");
  const tag = normalizedGroup(input.tag, "tag");
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
  return normalizedGroup({
    include: await resolve(selectors.include),
    exclude: await resolve(selectors.exclude)
  }, noun);
}

export async function resolveImageFilterPlan(input: ImageFilterInput) {
  const [theme, tag, author] = await Promise.all([
    resolveSelector(input.t, "theme", resolveThemeSlugs),
    resolveSelector(input.tag, "tag", resolveTagNames),
    resolveSelector(input.a, "author", resolveAuthorSlugs)
  ]);
  return createImageFilterPlan({
    devices: input.d ? [input.d] : devices,
    brightnesses: input.b ? [input.b] : brightnesses,
    theme,
    tag,
    author
  });
}

export function imageFilterPlanWithout(
  plan: ImageFilterPlan,
  dimension: ImageFilterDimension
) {
  const planDevices = [...new Set(plan.axes.map((axis) => axis.device))];
  const planBrightnesses = [
    ...new Set(plan.axes.map((axis) => axis.brightness))
  ];
  return createImageFilterPlan({
    devices: dimension === "device" ? devices : planDevices,
    brightnesses: dimension === "brightness"
      ? brightnesses
      : planBrightnesses,
    theme: dimension === "theme" ? undefined : plan.theme,
    tag: dimension === "tag" ? undefined : plan.tag,
    author: dimension === "author" ? undefined : plan.author
  });
}

export function imageFilterPlanHasAllAxes(plan: ImageFilterPlan) {
  if (plan.axes.length !== IMAGE_FILTER_AXES.length) return false;
  const selected = new Set(plan.axes.map((axis) => (
    `${axis.device}:${axis.brightness}`
  )));
  return IMAGE_FILTER_AXES.every((axis) => (
    selected.has(`${axis.device}:${axis.brightness}`)
  ));
}
