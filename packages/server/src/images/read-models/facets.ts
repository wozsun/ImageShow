import {
  brightnesses,
  devices,
  type GalleryFacetsDto
} from "@imageshow/shared/browser";
import { coalesce } from "../../core/coalesce.ts";
import { pool } from "../../core/db.ts";
import { createReadyImageFilterPlan } from "../ready-cache/filters.ts";
import { readReadyImageCountSnapshot } from "../ready-cache/counts.ts";
import {
  getAuthorVocab,
  getTagVocab,
  getThemeVocab
} from "../../vocab/vocab-cache.ts";

type FacetMembershipRow = {
  themes: string[];
  tags: string[];
  authors: string[];
};

async function facetVocabulary(
  counts: {
    themes: Record<string, number>;
    tags: Record<string, number>;
    authors: Record<string, number>;
  }
): Promise<GalleryFacetsDto> {
  const [themeVocab, tagVocab, authorVocab] = await Promise.all([
    getThemeVocab(),
    getTagVocab(),
    getAuthorVocab()
  ]);
  return {
    devices: [...devices],
    brightnesses: [...brightnesses],
    themes: themeVocab.filter(({ slug }) => (counts.themes[slug] ?? 0) > 0),
    tags: tagVocab.filter(({ slug }) => (counts.tags[slug] ?? 0) > 0),
    authors: authorVocab.filter(({ slug }) => (counts.authors[slug] ?? 0) > 0)
  };
}

async function readFacetsFromPostgres() {
  const row = (await pool.query(
    `SELECT
       ARRAY(
         SELECT DISTINCT m.theme
           FROM metadata m
          WHERE m.status='ready'
       ) AS themes,
       ARRAY(
         SELECT DISTINCT it.tag_slug
           FROM image_tag it
           JOIN metadata m ON m.id=it.image_id AND m.status='ready'
       ) AS tags,
       ARRAY(
         SELECT DISTINCT m.author
           FROM metadata m
          WHERE m.status='ready' AND m.author IS NOT NULL
       ) AS authors`
  )).rows[0] as FacetMembershipRow;
  return facetVocabulary({
    themes: Object.fromEntries((row.themes ?? []).map((slug) => [slug, 1])),
    tags: Object.fromEntries((row.tags ?? []).map((slug) => [slug, 1])),
    authors: Object.fromEntries((row.authors ?? []).map((slug) => [slug, 1]))
  });
}

export async function getPublicGalleryFacets(): Promise<GalleryFacetsDto> {
  const cached = await readReadyImageCountSnapshot(
    createReadyImageFilterPlan({})
  );
  if (cached.cached) return facetVocabulary(cached.value);
  return coalesce("gallery-facets:postgres", readFacetsFromPostgres);
}
