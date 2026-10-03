import { unsetThemeFilter } from "@imageshow/shared/browser";
import type { FacetOptionDto, GalleryStatsFacetDto } from "@imageshow/shared/browser";
import { displayNameOrSlug } from "../../lib/ui/formatters.js";
import { publicFilterOptionState } from "../../lib/gallery/public-filter-options.js";

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

export function boundedHomeRevealIndexes(
  items: readonly GalleryStatsFacetDto[],
  selected: ReadonlySet<string>,
  availabilityUnverified: boolean,
  limit: number
) {
  const indexes = new Map<string, number>();
  for (const item of items) {
    const isSelected = selected.has(item.slug);
    const { disabled, locked } = publicFilterOptionState({
      selected: isSelected,
      count: item.image_count,
      unverified: availabilityUnverified
    });
    if (disabled || locked || indexes.size >= limit) continue;
    indexes.set(item.slug, indexes.size);
  }
  return indexes;
}

export function selectedSlugs(value: string) {
  return value
    .split(",").filter(Boolean);
}

/**
 * Lists the members counted by the statistics in session facet order. A member
 * newer than the loaded facets keeps its slug until the facets revalidate.
 */
export function homeFacetOptions(
  counts: readonly GalleryStatsFacetDto[],
  facets: readonly FacetOptionDto[]
): Array<GalleryStatsFacetDto & FacetOptionDto> {
  const imageCounts = new Map(counts.map((item) => [item.slug, item.image_count]));
  const named = facets
    .filter((entry) => imageCounts.has(entry.slug))
    .map((entry) => ({
      slug: entry.slug,
      display_name: entry.display_name,
      image_count: imageCounts.get(entry.slug)!
    }));
  const namedSlugs = new Set(named.map((item) => item.slug));
  return [
    ...named,
    ...counts
      .filter((item) => !namedSlugs.has(item.slug))
      .map((item) => ({ ...item, display_name: "" }))
  ];
}

export function facetLabel(item: { slug: string; display_name?: string }) {
  if (item.slug === unsetThemeFilter && !item.display_name?.trim()) return "未设置";
  return displayNameOrSlug(item);
}

export function countLabel(count: number) {
  return `${homeNumberFormatter.format(count)} 张`;
}

export function selectedFacetLabels(
  items: readonly FacetOptionDto[],
  value: string
) {
  const names = new Map(items.map((item) => [item.slug, facetLabel(item)]));
  return value
    .split(",")
    .map((slug) => slug.replace(/^!/, ""))
    .filter(Boolean)
    .map((slug) => names.get(slug) ?? facetLabel({ slug }));
}
