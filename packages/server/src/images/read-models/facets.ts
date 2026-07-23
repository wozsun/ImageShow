import { coalesce } from "../../core/coalesce.ts";
import type { FacetOptionDto, GalleryFacetsDto } from "@imageshow/shared";
import { pool } from "../../core/db.ts";
import { getGalleryFilterOptions } from "../../random/cache-read.ts";
import { getThemeVocab } from "../../vocab/vocab-cache.ts";
import {
  getGalleryFacetsCache,
  imageCacheRevision,
  setGalleryFacetsCache
} from "../image-cache.ts";

type AuthorOption = { slug: string; display_name: string; link: string };

export async function getPublicGalleryFacets(): Promise<GalleryFacetsDto> {
  const revision = await imageCacheRevision();
  const cached = await getGalleryFacetsCache<GalleryFacetsDto>(revision);
  if (cached) return cached;

  return coalesce(`gallery-facets:${revision}`, async () => {
    const raced = await getGalleryFacetsCache<GalleryFacetsDto>(revision);
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
    const themes: FacetOptionDto[] = base.themes.map((slug) => ({
      slug,
      display_name: themeNames.get(slug) || ""
    }));
    const facets: GalleryFacetsDto = {
      devices: base.devices,
      brightnesses: base.brightnesses,
      themes,
      tags: tagResult.rows as FacetOptionDto[],
      authors: authorResult.rows as AuthorOption[]
    };
    await setGalleryFacetsCache(facets, revision);
    return facets;
  });
}
