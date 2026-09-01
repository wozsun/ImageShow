import type {
  GalleryFacetsDto,
  GalleryImageCardDto
} from "@imageshow/shared/browser";
import { displayNameOrSlug } from "../ui/formatters.js";

type GalleryDisplayFacets = Pick<GalleryFacetsDto, "themes" | "tags">;
type GalleryCardTaxonomy = Pick<GalleryImageCardDto, "theme" | "tags">;

function displayNameMap(
  entries: GalleryDisplayFacets["themes"] | GalleryDisplayFacets["tags"]
) {
  return new Map(entries.map((entry) => [
    entry.slug,
    displayNameOrSlug(entry)
  ]));
}

/**
 * Build one formatter per facets snapshot so every mounted tile can resolve
 * its stable slugs without rebuilding vocabulary maps. A missing or failed
 * facets query falls back to slugs; the reserved `none` theme stays hidden.
 */
export function createGalleryTaxonomyDisplayFormatter(
  facets: GalleryDisplayFacets | undefined
) {
  const themeNames = displayNameMap(facets?.themes ?? []);
  const tagNames = displayNameMap(facets?.tags ?? []);
  return ({ theme, tags }: GalleryCardTaxonomy) => {
    const themeLabel = theme === "none"
      ? themeNames.get(theme) ?? "未设置"
      : themeNames.get(theme) ?? theme;
    const tagLabels = tags.map((tag) => tagNames.get(tag) ?? tag);
    return {
      themeLabel,
      tagLabels,
      subtitle: [
        theme === "none" ? "" : themeLabel,
        tagLabels.join("/")
      ].filter(Boolean).join(" · ")
    };
  };
}
