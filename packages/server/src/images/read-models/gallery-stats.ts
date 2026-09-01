import { appConfig } from "@imageshow/shared";
import {
  brightnesses,
  devices,
  type Brightness,
  type Device,
  type GalleryStatsDto
} from "@imageshow/shared/browser";
import { coalesce } from "../../core/coalesce.ts";
import {
  withPublicDatabaseRead,
  publicPgFallbackWorkLimitExceeded,
  type PublicDatabaseReadAccess
} from "../../core/database/public-fallback.ts";
import { pool, type DatabaseReader } from "../../core/database/pools.ts";
import {
  readReadyImageCountSnapshot,
  type ReadyImageCountSnapshot
} from "../ready-cache/counts/query.ts";
import {
  resolveImageFilterPlan,
  type ImageFilterPlan
} from "../filter-plan.ts";
import {
  buildImageFilterSql,
  type ImageFilterAxis
} from "./image-filter-sql.ts";
import {
  getAuthorVocab,
  getTagVocab,
  getThemeVocab
} from "../../vocab/vocab-cache.ts";

export type GalleryStatsQuery = {
  device?: Device;
  brightness?: Brightness;
  theme?: string;
  tag?: string;
  author?: string;
};
type CategoryRow = {
  device: Device;
  brightness: Brightness;
  image_count: number;
};

type DeviceRow = {
  device: Device;
  image_count: number;
};

type BrightnessRow = {
  brightness: Brightness;
  image_count: number;
};

type FacetCountRow = {
  slug: string;
  display_name: string;
  image_count: number;
};

type AuthorCountRow = FacetCountRow & {
  link: string;
};

function numericCount(value: unknown) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

// Candidate counts intentionally omit their own axis: selections on one axis
// remain an OR union, while every other active axis stays an AND constraint.
function buildFilterClause(
  plan: ImageFilterPlan,
  omittedAxes: readonly ImageFilterAxis[] = []
) {
  const clause = buildImageFilterSql({
    status: "ready",
    plan
  }, { alias: "m", omittedAxes });
  return { params: clause.params, where: clause.where.join(" AND ") };
}

async function filteredRows<T>(
  client: DatabaseReader,
  plan: ImageFilterPlan,
  omittedAxes: readonly ImageFilterAxis[],
  sql: (where: string, rowLimit: string) => string
) {
  const clause = buildFilterClause(plan, omittedAxes);
  clause.params.push(appConfig.publicPgFallback.maximumVocabularyRows + 1);
  const result = await client.query(
    sql(clause.where, `$${clause.params.length}`),
    clause.params
  );
  return result.rows as T[];
}

async function readPublicGalleryStats(
  plan: ImageFilterPlan,
  client: DatabaseReader,
  signal: AbortSignal
): Promise<GalleryStatsDto> {
  const {
    totalResult,
    matchingRows,
    categoryRows,
    deviceRows,
    brightnessRows,
    themeRows,
    tagRows,
    authorRows
  } = await (async () => {
    signal.throwIfAborted();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const totalResult = await client.query(
        "SELECT count(*)::int AS image_count FROM metadata WHERE status='ready'"
      );
      const matchingRows = await filteredRows<{ image_count: number }>(
        client,
        plan,
        [],
        (where, rowLimit) => `SELECT count(*)::int AS image_count
          FROM metadata m WHERE ${where} LIMIT ${rowLimit}`
      );
      const categoryRows = await filteredRows<CategoryRow>(
        client,
        plan,
        [],
        (where, rowLimit) => `SELECT m.device, m.brightness, count(*)::int AS image_count
                      FROM metadata m
                     WHERE ${where}
                     GROUP BY m.device, m.brightness
                     LIMIT ${rowLimit}`
      );
      const deviceRows = await filteredRows<DeviceRow>(
        client,
        plan,
        ["device"],
        (where, rowLimit) => `SELECT m.device, count(*)::int AS image_count
                      FROM metadata m
                     WHERE ${where}
                     GROUP BY m.device
                     LIMIT ${rowLimit}`
      );
      const brightnessRows = await filteredRows<BrightnessRow>(
        client,
        plan,
        ["brightness"],
        (where, rowLimit) => `SELECT m.brightness, count(*)::int AS image_count
                      FROM metadata m
                     WHERE ${where}
                     GROUP BY m.brightness
                     LIMIT ${rowLimit}`
      );
      const themeRows = await filteredRows<FacetCountRow>(
        client,
        plan,
        ["theme"],
        (where, rowLimit) => `SELECT t.slug,
                            t.display_name,
                            count(m.id)::int AS image_count
                       FROM theme t
                       LEFT JOIN metadata m
                         ON m.theme=t.slug
                        AND ${where}
                      GROUP BY t.slug, t.display_name, t.sort_order
                      ORDER BY (t.slug='none') DESC, t.sort_order ASC, t.slug ASC
                      LIMIT ${rowLimit}`
      );
      const tagRows = await filteredRows<FacetCountRow>(
        client,
        plan,
        ["tag"],
        (where, rowLimit) => `SELECT t.slug,
                            t.display_name,
                            count(DISTINCT m.id)::int AS image_count
                       FROM tag t
                       LEFT JOIN image_tag facet_it ON facet_it.tag_slug=t.slug
                       LEFT JOIN metadata m
                         ON m.id=facet_it.image_id
                        AND ${where}
                      GROUP BY t.slug, t.display_name, t.sort_order
                      ORDER BY t.sort_order ASC, t.slug ASC
                      LIMIT ${rowLimit}`
      );
      const authorRows = await filteredRows<AuthorCountRow>(
        client,
        plan,
        ["author"],
        (where, rowLimit) => `SELECT a.slug,
                            a.display_name,
                            a.link,
                            count(m.id)::int AS image_count
                       FROM author a
                       LEFT JOIN metadata m
                         ON m.author=a.slug
                        AND ${where}
                      GROUP BY a.slug, a.display_name, a.link, a.sort_order
                      ORDER BY a.sort_order ASC, a.slug ASC
                      LIMIT ${rowLimit}`
      );

      if ([themeRows, tagRows, authorRows].some((rows) => (
        rows.length > appConfig.publicPgFallback.maximumVocabularyRows
      ))) {
        throw publicPgFallbackWorkLimitExceeded(
          "Gallery statistics exceed the public result limit"
        );
      }

      signal.throwIfAborted();
      await client.query("COMMIT");
      return {
        totalResult,
        matchingRows,
        categoryRows,
        deviceRows,
        brightnessRows,
        themeRows,
        tagRows,
        authorRows
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  })();

  const categoryCounts = new Map(
    categoryRows.map((row) => [
      `${row.device}:${row.brightness}`,
      numericCount(row.image_count)
    ])
  );
  const deviceCounts = new Map(
    deviceRows.map((row) => [row.device, numericCount(row.image_count)])
  );
  const brightnessCounts = new Map(
    brightnessRows.map((row) => [row.brightness, numericCount(row.image_count)])
  );

  return {
    total_images: numericCount(totalResult.rows[0]?.image_count),
    matching_images: numericCount(matchingRows[0]?.image_count),
    devices: devices.map((device) => ({
      device,
      image_count: deviceCounts.get(device) ?? 0
    })),
    brightnesses: brightnesses.map((brightness) => ({
      brightness,
      image_count: brightnessCounts.get(brightness) ?? 0
    })),
    categories: devices.flatMap((device) =>
      brightnesses.map((brightness) => ({
        device,
        brightness,
        image_count: categoryCounts.get(`${device}:${brightness}`) ?? 0
      }))
    ),
    themes: themeRows.map((row) => ({
      slug: row.slug,
      display_name: row.display_name,
      image_count: numericCount(row.image_count)
    })),
    tags: tagRows.map((row) => ({
      slug: row.slug,
      display_name: row.display_name,
      image_count: numericCount(row.image_count)
    })),
    authors: authorRows.map((row) => ({
      slug: row.slug,
      display_name: row.display_name,
      link: row.link,
      image_count: numericCount(row.image_count)
    }))
  };
}

async function presentCachedGalleryStats(
  snapshot: ReadyImageCountSnapshot,
  database: PublicDatabaseReadAccess = {}
): Promise<GalleryStatsDto> {
  const [themeVocab, tagVocab, authorVocab] = await Promise.all([
    getThemeVocab(database),
    getTagVocab(database),
    getAuthorVocab(database)
  ]);
  return {
    total_images: snapshot.total,
    matching_images: snapshot.matching,
    devices: devices.map((device) => ({
      device,
      image_count: snapshot.devices[device] ?? 0
    })),
    brightnesses: brightnesses.map((brightness) => ({
      brightness,
      image_count: snapshot.brightnesses[brightness] ?? 0
    })),
    categories: devices.flatMap((device) => (
      brightnesses.map((brightness) => ({
        device,
        brightness,
        image_count: snapshot.axes[`${device}:${brightness}`] ?? 0
      }))
    )),
    themes: themeVocab.map((entry) => ({
      ...entry,
      image_count: snapshot.themes[entry.slug] ?? 0
    })),
    tags: tagVocab.map((entry) => ({
      ...entry,
      image_count: snapshot.tags[entry.slug] ?? 0
    })),
    authors: authorVocab.map((entry) => ({
      ...entry,
      image_count: snapshot.authors[entry.slug] ?? 0
    }))
  };
}

async function getPublicGalleryStatsWithAccess(
  query: GalleryStatsQuery,
  signal: AbortSignal | undefined,
  database: PublicDatabaseReadAccess
): Promise<GalleryStatsDto> {
  const plan = await resolveImageFilterPlan(query, database);
  const cached = await readReadyImageCountSnapshot(
    plan,
    signal,
    Boolean(database.reader)
  );
  if (cached.cached) return presentCachedGalleryStats(cached.value, database);
  if (database.reader) {
    return readPublicGalleryStats(
      plan,
      database.reader,
      signal ?? new AbortController().signal
    );
  }
  const load = async () => {
    const client = await pool.connect();
    try {
      return await readPublicGalleryStats(
        plan,
        client,
        new AbortController().signal
      );
    } finally {
      client.release();
    }
  };
  return coalesce(`gallery-stats:postgres:${plan.signature}`, load);
}

export function getPublicGalleryStats(
  query: GalleryStatsQuery = {},
  signal?: AbortSignal
): Promise<GalleryStatsDto> {
  return signal
    ? withPublicDatabaseRead(signal, (database, databaseSignal) => (
        getPublicGalleryStatsWithAccess(query, databaseSignal, database)
      ))
    : getPublicGalleryStatsWithAccess(query, undefined, {});
}
