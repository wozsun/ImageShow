import type { FacetOptionDto } from "@imageshow/shared/browser";

type GallerySubtitleSource = {
  theme: string;
  tags: readonly string[];
};

function displayNameMap(entries: readonly FacetOptionDto[]) {
  return new Map(entries.map((entry) => [
    entry.slug,
    entry.display_name.trim() || entry.slug
  ]));
}

/**
 * Builds the stable Gallery subtitle formatter for one presentation batch.
 * The reserved `none` theme represents an absent theme and is therefore not
 * rendered; known display names fall back to their slugs only when empty.
 */
export function createGallerySubtitleFormatter(
  themes: readonly FacetOptionDto[],
  tags: readonly FacetOptionDto[]
) {
  const themeNames = displayNameMap(themes);
  const tagNames = displayNameMap(tags);
  return ({ theme, tags: imageTags }: GallerySubtitleSource) => {
    const themeName = theme && theme !== "none"
      ? themeNames.get(theme) ?? theme
      : "";
    const tagNamesText = imageTags
      .map((tag) => tagNames.get(tag) ?? tag)
      .join("/");
    return [themeName, tagNamesText].filter(Boolean).join(" · ");
  };
}
