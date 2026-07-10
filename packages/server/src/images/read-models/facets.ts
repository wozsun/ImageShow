import { coalesce } from "../../core/coalesce.ts";
import { pool } from "../../core/db.ts";
import { getGalleryFilterOptions } from "../../random/random-cache.ts";
import { getThemeVocab } from "../../vocab/vocab-cache.ts";
import {
  getGalleryFacetsCache,
  setGalleryFacetsCache
} from "../image-cache.ts";

type FacetOption = { slug: string; display_name: string };
type AuthorOption = { slug: string; display_name: string; link: string };
type GalleryFacets = {
  devices: string[];
  brightnesses: string[];
  themes: FacetOption[];
  tags: FacetOption[];
  authors: AuthorOption[];
};

export async function getPublicGalleryFacets(): Promise<GalleryFacets> {
  const cached = await getGalleryFacetsCache<GalleryFacets>();
  if (cached) return cached;

  return coalesce("gallery-facets", async () => {
    const raced = await getGalleryFacetsCache<GalleryFacets>();
    if (raced) return raced;

    const [base, themeVocab, tagResult, authorResult] = await Promise.all([
      getGalleryFilterOptions(),
      getThemeVocab(),
      pool.query(
        `SELECT DISTINCT it.tag_slug AS slug, COALESCE(tg.display_name, '') AS display_name
         FROM image_tag it
         JOIN metadata m ON m.id = it.image_id AND m.status='ready'
         LEFT JOIN tag tg ON tg.slug = it.tag_slug
         ORDER BY it.tag_slug`
      ),
      pool.query(
        `SELECT a.slug, COALESCE(a.display_name, '') AS display_name, COALESCE(a.link, '') AS link
         FROM author a
         WHERE EXISTS (
           SELECT 1 FROM metadata m WHERE m.author = a.slug AND m.status='ready'
         )
         ORDER BY a.sort_order ASC, a.slug ASC`
      )
    ]);

    const themeNames = new Map(
      themeVocab.map((entry) => [entry.slug, entry.display_name])
    );
    const themes: FacetOption[] = base.themes.map((slug) => ({
      slug,
      display_name: themeNames.get(slug) || ""
    }));
    const facets: GalleryFacets = {
      devices: base.devices,
      brightnesses: base.brightnesses,
      themes,
      tags: tagResult.rows as FacetOption[],
      authors: authorResult.rows as AuthorOption[]
    };
    await setGalleryFacetsCache(facets);
    return facets;
  });
}
