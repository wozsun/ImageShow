import { appConfig } from "@imageshow/shared";
import { unsetThemeFilter, type Brightness, type Device } from "@imageshow/shared/browser";
import {
  publicPgFallbackWorkLimitExceeded,
  type PublicDatabaseReadAccess
} from "../../core/database/public-fallback.ts";
import type { DatabaseReader } from "../../core/database/pools.ts";
import {
  getAuthorVocab, getTagVocab, getThemeVocab,
  type AuthorVocabEntry, type VocabEntry
} from "../../vocab/vocab-cache.ts";
import type { ImageFilterPlan } from "../filter-plan.ts";
import {
  activeReadyImageCounts, isUnfilteredReadyImagePlan,
  nonNegativeReadyImageCount, type ReadyImageCountSnapshot
} from "../ready-cache/counts/model.ts";
import type { ReadyImageCountContext } from "../ready-cache/counts/query.ts";
import { getReadyImageRevision } from "../ready-cache/revision.ts";
import { buildImageFilterSql, type ImageFilterAxis } from "./image-filter-sql.ts";

type CountRow = { image_count: number };
type CategoryRow = CountRow & { device: Device; brightness: Brightness };
type MemberCountRow = CountRow & { slug: string };
type FacetCountRow = MemberCountRow & VocabEntry;
type AuthorCountRow = MemberCountRow & AuthorVocabEntry;

export type GalleryStatsVocabulary = {
  themes: VocabEntry[];
  tags: VocabEntry[];
  authors: AuthorVocabEntry[];
};

export async function readGalleryStatsVocabulary(database: PublicDatabaseReadAccess) {
  const [themes, tags, authors] = await Promise.all([
    getThemeVocab(database), getTagVocab(database), getAuthorVocab(database)
  ]);
  return { themes, tags, authors };
}

function count(value: unknown) {
  const result = nonNegativeReadyImageCount(value);
  if (result === null) throw new Error("Invalid gallery image count");
  return result;
}

function countsBy<T extends CountRow>(rows: T[], key: (row: T) => string) {
  return Object.fromEntries(rows.map((row) => [key(row), count(row.image_count)]));
}

function categorySnapshot(rows: CategoryRow[]) {
  let matching = 0;
  const axes: Record<string, number> = {};
  const devices: Record<string, number> = {};
  const brightnesses: Record<string, number> = {};
  // Validate and sum the complete grouping before projecting supported UI axes.
  for (const row of rows) {
    const value = count(row.image_count);
    matching = count(matching + value);
    axes[`${row.device}:${row.brightness}`] = value;
    devices[row.device] = count((devices[row.device] ?? 0) + value);
    brightnesses[row.brightness] = count((brightnesses[row.brightness] ?? 0) + value);
  }
  return { matching, axes, devices, brightnesses };
}

// Candidate counts omit their own axis, preserving OR within and AND across axes.
async function filteredRows<T>(
  client: DatabaseReader,
  plan: ImageFilterPlan,
  omittedAxes: readonly ImageFilterAxis[],
  sql: (where: string, rowLimit: string) => string
) {
  const clause = buildImageFilterSql({ status: "ready", plan }, { alias: "m", omittedAxes });
  clause.params.push(appConfig.publicPgFallback.maximumVocabularyRows + 1);
  const result = await client.query(sql(clause.where.join(" AND "), `$${clause.params.length}`), clause.params);
  if (result.rows.length > appConfig.publicPgFallback.maximumVocabularyRows) {
    throw publicPgFallbackWorkLimitExceeded("Gallery statistics exceed the public result limit");
  }
  return result.rows as T[];
}

function countsForGlobalMembers(
  rows: MemberCountRow[],
  globalStats: Map<string, number>,
  prefix: string
) {
  const members = Object.keys(activeReadyImageCounts(globalStats, prefix));
  if (members.length > appConfig.publicPgFallback.maximumVocabularyRows) {
    throw publicPgFallbackWorkLimitExceeded("Gallery statistics exceed the public result limit");
  }
  const result: Record<string, number> = Object.fromEntries(members.map((slug) => [slug, 0]));
  for (const row of rows) {
    if (!Object.hasOwn(result, row.slug)) throw new Error("Gallery count member is outside its revision snapshot");
    result[row.slug] = count(row.image_count);
  }
  return result;
}

async function readFacetCounts(
  client: DatabaseReader,
  plan: ImageFilterPlan,
  globalStats: Map<string, number> | null
) {
  if (globalStats) {
    const themeRows = await filteredRows<MemberCountRow>(client, plan, ["theme"], (where, limit) => (
      `SELECT coalesce(m.theme, '${unsetThemeFilter}') AS slug, count(*)::int AS image_count
         FROM metadata m WHERE ${where} GROUP BY m.theme LIMIT ${limit}`
    ));
    const tagRows = await filteredRows<MemberCountRow>(client, plan, ["tag"], (where, limit) => (
      `SELECT facet_it.tag_slug AS slug, count(*)::int AS image_count
         FROM metadata m JOIN image_tag facet_it ON facet_it.image_id=m.id
        WHERE ${where} GROUP BY facet_it.tag_slug LIMIT ${limit}`
    ));
    const authorRows = await filteredRows<MemberCountRow>(client, plan, ["author"], (where, limit) => (
      `SELECT m.author AS slug, count(*)::int AS image_count
         FROM metadata m WHERE ${where} AND m.author IS NOT NULL
        GROUP BY m.author LIMIT ${limit}`
    ));
    return {
      themes: countsForGlobalMembers(themeRows, globalStats, "theme:"),
      tags: countsForGlobalMembers(tagRows, globalStats, "tag:"),
      authors: countsForGlobalMembers(authorRows, globalStats, "author:"),
      vocabulary: null
    };
  }

  const themeRows = await filteredRows<FacetCountRow>(client, plan, ["theme"], (where, limit) => (
    `SELECT slug, display_name, image_count FROM (
       SELECT t.slug, t.display_name,
              (count(m.id) FILTER (WHERE ${where}))::int AS image_count,
              t.sort_order, false AS is_unset
         FROM theme t JOIN metadata m ON m.theme=t.slug AND m.status='ready'
        GROUP BY t.slug, t.display_name, t.sort_order
       UNION ALL
       SELECT '${unsetThemeFilter}', '未设置',
              (count(*) FILTER (WHERE ${where}))::int, 0, true
         FROM metadata m WHERE m.theme IS NULL AND m.status='ready'
       HAVING count(*) > 0
     ) facets ORDER BY is_unset DESC, sort_order DESC, slug ASC LIMIT ${limit}`
  ));
  const tagRows = await filteredRows<FacetCountRow>(client, plan, ["tag"], (where, limit) => (
    `SELECT t.slug, t.display_name,
            (count(m.id) FILTER (WHERE ${where}))::int AS image_count
       FROM tag t JOIN image_tag facet_it ON facet_it.tag_slug=t.slug
       JOIN metadata m ON m.id=facet_it.image_id AND m.status='ready'
      GROUP BY t.slug, t.display_name, t.sort_order
      ORDER BY t.sort_order DESC, t.slug ASC LIMIT ${limit}`
  ));
  const authorRows = await filteredRows<AuthorCountRow>(client, plan, ["author"], (where, limit) => (
    `SELECT a.slug, a.display_name, a.link,
            (count(m.id) FILTER (WHERE ${where}))::int AS image_count
       FROM author a JOIN metadata m ON m.author=a.slug AND m.status='ready'
      GROUP BY a.slug, a.display_name, a.link, a.sort_order
      ORDER BY a.sort_order DESC, a.slug ASC LIMIT ${limit}`
  ));
  return {
    themes: countsBy(themeRows, (row) => row.slug),
    tags: countsBy(tagRows, (row) => row.slug),
    authors: countsBy(authorRows, (row) => row.slug),
    vocabulary: {
      themes: themeRows.map(({ slug, display_name }) => ({ slug, display_name })),
      tags: tagRows.map(({ slug, display_name }) => ({ slug, display_name })),
      authors: authorRows.map(({ slug, display_name, link }) => ({ slug, display_name, link }))
    } satisfies GalleryStatsVocabulary
  };
}

export async function readPublicGalleryCountSnapshot(
  plan: ImageFilterPlan,
  client: DatabaseReader,
  signal: AbortSignal,
  context?: ReadyImageCountContext
) {
  signal.throwIfAborted();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  let result: { snapshot: ReadyImageCountSnapshot; vocabulary: GalleryStatsVocabulary | null };
  try {
    const unfiltered = isUnfilteredReadyImagePlan(plan);
    // The unfiltered path always uses four business SELECTs, without a revision query.
    const globalStats = !unfiltered && context
      && (await getReadyImageRevision(client)).revision === context.revision
      ? context.globalStats
      : null;
    const categoryRows = await filteredRows<CategoryRow>(client, plan, [], (where, limit) => (
      `SELECT m.device, m.brightness, count(*)::int AS image_count
         FROM metadata m WHERE ${where} GROUP BY m.device, m.brightness LIMIT ${limit}`
    ));
    const categories = categorySnapshot(categoryRows);
    const total = unfiltered ? categories.matching : globalStats
      ? count(globalStats.get("total"))
      : count((await client.query(
          "SELECT count(*)::int AS image_count FROM metadata WHERE status='ready'"
        )).rows[0]?.image_count);
    const devices = unfiltered ? categories.devices : countsBy(
      await filteredRows<CountRow & { device: Device }>(client, plan, ["device"], (where, limit) => (
        `SELECT m.device, count(*)::int AS image_count FROM metadata m
          WHERE ${where} GROUP BY m.device LIMIT ${limit}`
      )), (row) => row.device
    );
    const brightnesses = unfiltered ? categories.brightnesses : countsBy(
      await filteredRows<CountRow & { brightness: Brightness }>(client, plan, ["brightness"], (where, limit) => (
        `SELECT m.brightness, count(*)::int AS image_count FROM metadata m
          WHERE ${where} GROUP BY m.brightness LIMIT ${limit}`
      )), (row) => row.brightness
    );
    const facets = await readFacetCounts(client, plan, globalStats);
    signal.throwIfAborted();
    await client.query("COMMIT");
    result = {
      snapshot: {
        total, matching: categories.matching, axes: categories.axes, devices, brightnesses,
        themes: facets.themes, tags: facets.tags, authors: facets.authors
      } satisfies ReadyImageCountSnapshot,
      vocabulary: facets.vocabulary
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  const vocabulary = result.vocabulary ?? await readGalleryStatsVocabulary({ reader: client });
  signal.throwIfAborted();
  return { snapshot: result.snapshot, vocabulary };
}
