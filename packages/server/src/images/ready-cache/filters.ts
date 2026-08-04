import type { Brightness, Device } from "@imageshow/shared/browser";
import { resolveAuthorSlugs } from "../../authors/query.ts";
import { ApiError } from "../../core/api-error.ts";
import { splitSelectors } from "../../core/selectors.ts";
import { resolveTagNames } from "../../tags/query.ts";
import { resolveThemeSlugs } from "../../themes/query.ts";

export type ReadyImageSelectorGroup = {
  include: string[];
  exclude: string[];
};

export type ReadyImageFilterPlan = {
  axes: Array<{ device: Device; brightness: Brightness }>;
  theme: ReadyImageSelectorGroup;
  tag: ReadyImageSelectorGroup;
  author: ReadyImageSelectorGroup;
  signature: string;
};

type ReadyImageListFilterInput = {
  d?: Device;
  b?: Brightness;
  t?: string;
  tag?: string;
  a?: string;
};

const devices = ["pc", "mb"] as const;
const brightnesses = ["dark", "light"] as const;

function normalizedGroup(group?: Partial<ReadyImageSelectorGroup>) {
  return {
    include: [...new Set(group?.include ?? [])].sort(),
    exclude: [...new Set(group?.exclude ?? [])].sort()
  };
}

export function createReadyImageFilterPlan(input: {
  devices?: readonly Device[];
  brightnesses?: readonly Brightness[];
  theme?: Partial<ReadyImageSelectorGroup>;
  tag?: Partial<ReadyImageSelectorGroup>;
  author?: Partial<ReadyImageSelectorGroup>;
}): ReadyImageFilterPlan {
  const selectedDevices = [...new Set(input.devices ?? devices)].sort();
  const selectedBrightnesses = [
    ...new Set(input.brightnesses ?? brightnesses)
  ].sort();
  const axes = selectedDevices.flatMap((device) => (
    selectedBrightnesses.map((brightness) => ({ device, brightness }))
  ));
  const theme = normalizedGroup(input.theme);
  const tag = normalizedGroup(input.tag);
  const author = normalizedGroup(input.author);
  const signature = JSON.stringify({ axes, theme, tag, author });
  return { axes, theme, tag, author, signature };
}

async function resolveSelector(
  raw: string | undefined,
  noun: string,
  resolve: (terms: string[]) => Promise<string[]>
) {
  if (!raw) return normalizedGroup();
  const selectors = splitSelectors([raw]);
  if (selectors.include.length && selectors.exclude.length) {
    throw new ApiError(
      400,
      "validation_error",
      `Cannot mix include and exclude ${noun} selectors`
    );
  }
  return normalizedGroup({
    include: await resolve(selectors.include),
    exclude: await resolve(selectors.exclude)
  });
}

export async function resolveReadyImageListFilterPlan(
  input: ReadyImageListFilterInput
) {
  const [theme, tag, author] = await Promise.all([
    resolveSelector(input.t, "theme", resolveThemeSlugs),
    resolveSelector(input.tag, "tag", resolveTagNames),
    resolveSelector(input.a, "author", resolveAuthorSlugs)
  ]);
  return createReadyImageFilterPlan({
    devices: input.d ? [input.d] : devices,
    brightnesses: input.b ? [input.b] : brightnesses,
    theme,
    tag,
    author
  });
}

export function readyImageFilterPlanWithout(
  plan: ReadyImageFilterPlan,
  dimension: "device" | "brightness" | "theme" | "tag" | "author"
) {
  const planDevices = [...new Set(plan.axes.map((axis) => axis.device))];
  const planBrightnesses = [
    ...new Set(plan.axes.map((axis) => axis.brightness))
  ];
  return createReadyImageFilterPlan({
    devices: dimension === "device" ? devices : planDevices,
    brightnesses: dimension === "brightness"
      ? brightnesses
      : planBrightnesses,
    theme: dimension === "theme" ? undefined : plan.theme,
    tag: dimension === "tag" ? undefined : plan.tag,
    author: dimension === "author" ? undefined : plan.author
  });
}
