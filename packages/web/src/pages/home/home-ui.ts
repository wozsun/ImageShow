import type { GalleryStatsFacetDto } from "@imageshow/shared/browser";
import { displayNameOrSlug } from "../../lib/ui/formatters.js";

export const deviceLabels: Record<string, string> = {
  "": "全部设备",
  pc: "桌面端",
  mb: "移动端"
};

export const brightnessLabels: Record<string, string> = {
  "": "全部明暗",
  dark: "暗色系",
  light: "亮色系"
};

export const deviceOptions = ["", "pc", "mb"] as const;
export const brightnessOptions = ["", "dark", "light"] as const;
export const homeNumberFormatter = new Intl.NumberFormat("zh-CN");
export const homeRevealItemLimits = {
  authors: 10,
  tags: 18,
  themes: 9
} as const;

type HomeFacetCount = {
  image_count: number;
  slug: string;
};

export function boundedHomeRevealIndexes(
  items: readonly HomeFacetCount[],
  selected: ReadonlySet<string>,
  availabilityUnverified: boolean,
  limit: number
) {
  const indexes = new Map<string, number>();
  for (const item of items) {
    const isSelected = selected.has(item.slug);
    const disabled = !isSelected && item.image_count === 0;
    const locked = availabilityUnverified && !isSelected;
    if (disabled || locked || indexes.size >= limit) continue;
    indexes.set(item.slug, indexes.size);
  }
  return indexes;
}

export function selectedSlugs(value: string) {
  return value.split(",").filter(Boolean);
}

export function facetLabel(item: {
  slug: string;
  display_name?: string;
}) {
  if (item.slug === "none" && !item.display_name?.trim()) return "未设置";
  return displayNameOrSlug(item);
}

export function countLabel(count: number) {
  return `${homeNumberFormatter.format(count)} 张`;
}

export function selectedFacetLabels(
  items: readonly GalleryStatsFacetDto[],
  value: string
) {
  const names = new Map(items.map((item) => [item.slug, facetLabel(item)]));
  return value
    .split(",")
    .map((slug) => slug.replace(/^!/, ""))
    .filter(Boolean)
    .map((slug) => names.get(slug) ?? slug);
}
