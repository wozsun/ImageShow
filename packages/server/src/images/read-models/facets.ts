import {
  brightnesses,
  devices,
  type GalleryFacetsDto
} from "@imageshow/shared/browser";
import { appConfig } from "@imageshow/shared";
import { coalesce } from "../../core/coalesce.ts";
import {
  withPublicDatabaseRead,
  publicPgFallbackWorkLimitExceeded,
  type PublicDatabaseReadAccess
} from "../../core/database/public-fallback.ts";
import { pool, type DatabaseReader } from "../../core/database/pools.ts";
import { createImageFilterPlan } from "../filter-plan.ts";
import { readReadyImageCountSnapshot } from "../ready-cache/counts/query.ts";
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
  },
  database: PublicDatabaseReadAccess = {}
): Promise<GalleryFacetsDto> {
  const [themeVocab, tagVocab, authorVocab] = await Promise.all([
    getThemeVocab(database),
    getTagVocab(database),
    getAuthorVocab(database)
  ]);
  return {
    devices: [...devices],
    brightnesses: [...brightnesses],
    themes: themeVocab.filter(({ slug }) => (counts.themes[slug] ?? 0) > 0),
    tags: tagVocab.filter(({ slug }) => (counts.tags[slug] ?? 0) > 0),
    authors: authorVocab.filter(({ slug }) => (counts.authors[slug] ?? 0) > 0)
  };
}

async function readFacetsFromPostgres(
  reader: DatabaseReader
) {
  const maximumRows = appConfig.publicPgFallback.maximumVocabularyRows;
  const row = (await reader.query(
    `SELECT
       ARRAY(
         SELECT DISTINCT m.theme
           FROM metadata m
          WHERE m.status='ready'
          LIMIT $1
       ) AS themes,
       ARRAY(
         SELECT DISTINCT it.tag_slug
           FROM image_tag it
           JOIN metadata m ON m.id=it.image_id AND m.status='ready'
          LIMIT $1
       ) AS tags,
       ARRAY(
         SELECT DISTINCT m.author
          FROM metadata m
          WHERE m.status='ready' AND m.author IS NOT NULL
          LIMIT $1
       ) AS authors`,
    [maximumRows + 1]
  )).rows[0] as FacetMembershipRow;
  if ([row.themes, row.tags, row.authors].some((values) => (
    (values?.length ?? 0) > maximumRows
  ))) {
    throw publicPgFallbackWorkLimitExceeded(
      "Gallery facets exceed the public result limit"
    );
  }
  return facetVocabulary({
    themes: Object.fromEntries((row.themes ?? []).map((slug) => [slug, 1])),
    tags: Object.fromEntries((row.tags ?? []).map((slug) => [slug, 1])),
    authors: Object.fromEntries((row.authors ?? []).map((slug) => [slug, 1]))
  }, { reader });
}

async function getPublicGalleryFacetsWithAccess(
  signal: AbortSignal | undefined,
  database: PublicDatabaseReadAccess
): Promise<GalleryFacetsDto> {
  const cached = await readReadyImageCountSnapshot(
    createImageFilterPlan({}),
    signal,
    Boolean(database.reader)
  );
  if (cached.cached) return facetVocabulary(cached.value, database);
  return database.reader
    ? readFacetsFromPostgres(database.reader)
    : coalesce(
        "gallery-facets:postgres",
        () => readFacetsFromPostgres(pool)
      );
}

export function getPublicGalleryFacets(
  signal?: AbortSignal
): Promise<GalleryFacetsDto> {
  return signal
    ? withPublicDatabaseRead(signal, (database, databaseSignal) => (
        getPublicGalleryFacetsWithAccess(databaseSignal, database)
      ))
    : getPublicGalleryFacetsWithAccess(undefined, {});
}
