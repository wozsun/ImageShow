import type { PoolClient } from "pg";
import type { z } from "zod";
import {
  brightnesses,
  devices,
  type Brightness,
  type Device,
  type GalleryStatsDto
} from "@imageshow/shared/browser";
import { ApiError } from "../../core/api-error.ts";
import { coalesce } from "../../core/coalesce.ts";
import { pool } from "../../core/db.ts";
import { splitSelectors } from "../../core/selectors.ts";
import { galleryStatsQuery } from "../../core/validation.ts";
import {
  getGalleryStatsCache,
  imageCacheRevision,
  setGalleryStatsCache
} from "../image-cache.ts";

type GalleryStatsQuery = z.infer<typeof galleryStatsQuery>;
type FilterAxis = "device" | "brightness" | "theme" | "tag" | "author";

type ParsedSelector = {
  exclude: boolean;
  values: string[];
};

type ParsedStatsFilters = {
  device?: Device;
  brightness?: Brightness;
  theme?: ParsedSelector;
  tag?: ParsedSelector;
  author?: ParsedSelector;
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

function parseSelector(value: string | undefined, noun: string) {
  if (!value) return undefined;
  const { include, exclude } = splitSelectors([value]);
  if (include.length && exclude.length) {
    throw new ApiError(
      400,
      "validation_error",
      `Cannot mix include and exclude ${noun} selectors`
    );
  }
  const isExclude = exclude.length > 0;
  return {
    exclude: isExclude,
    values: isExclude ? exclude : include
  };
}

function parseStatsFilters(query: GalleryStatsQuery): ParsedStatsFilters {
  return {
    device: query.d,
    brightness: query.b,
    theme: parseSelector(query.t, "theme"),
    tag: parseSelector(query.tag, "tag"),
    author: parseSelector(query.a, "author")
  };
}

function normalizedSelectorKey(selector: ParsedSelector | undefined) {
  if (!selector) return "";
  const values = [...selector.values].sort();
  return `${selector.exclude ? "!" : ""}${values.join(",")}`;
}

function galleryStatsCacheKey(filters: ParsedStatsFilters) {
  return JSON.stringify([
    filters.device ?? "",
    filters.brightness ?? "",
    normalizedSelectorKey(filters.theme),
    normalizedSelectorKey(filters.tag),
    normalizedSelectorKey(filters.author)
  ]);
}

// Candidate counts intentionally omit their own axis: selections on one axis
// remain an OR union, while every other active axis stays an AND constraint.
function buildFilterClause(
  filters: ParsedStatsFilters,
  omittedAxes: readonly FilterAxis[] = []
) {
  const omitted = new Set(omittedAxes);
  const params: unknown[] = [];
  const where = ["m.status='ready'"];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (!omitted.has("device") && filters.device) {
    where.push(`m.device=${bind(filters.device)}`);
  }
  if (!omitted.has("brightness") && filters.brightness) {
    where.push(`m.brightness=${bind(filters.brightness)}`);
  }
  if (!omitted.has("theme") && filters.theme) {
    const parameter = bind(filters.theme.values);
    where.push(filters.theme.exclude
      ? `NOT (m.theme=ANY(${parameter}::text[]))`
      : `m.theme=ANY(${parameter}::text[])`);
  }
  if (!omitted.has("tag") && filters.tag) {
    const parameter = bind(filters.tag.values);
    const exists = `EXISTS (
      SELECT 1
        FROM image_tag filter_it
       WHERE filter_it.image_id=m.id
         AND filter_it.tag_slug=ANY(${parameter}::text[])
    )`;
    where.push(filters.tag.exclude ? `NOT ${exists}` : exists);
  }
  if (!omitted.has("author") && filters.author) {
    const parameter = bind(filters.author.values);
    where.push(filters.author.exclude
      ? `(m.author IS NULL OR NOT (m.author=ANY(${parameter}::text[])))`
      : `m.author=ANY(${parameter}::text[])`);
  }

  return { params, where: where.join(" AND ") };
}

async function filteredRows<T>(
  client: PoolClient,
  filters: ParsedStatsFilters,
  omittedAxes: readonly FilterAxis[],
  sql: (where: string) => string
) {
  const clause = buildFilterClause(filters, omittedAxes);
  const result = await client.query(sql(clause.where), clause.params);
  return result.rows as T[];
}

async function readPublicGalleryStats(
  filters: ParsedStatsFilters
): Promise<GalleryStatsDto> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const totalResult = await client.query(
      "SELECT count(*)::int AS image_count FROM metadata WHERE status='ready'"
    );
    const matchingRows = await filteredRows<{ image_count: number }>(
      client,
      filters,
      [],
      (where) => `SELECT count(*)::int AS image_count FROM metadata m WHERE ${where}`
    );
    const categoryRows = await filteredRows<CategoryRow>(
      client,
      filters,
      [],
      (where) => `SELECT m.device, m.brightness, count(*)::int AS image_count
                    FROM metadata m
                   WHERE ${where}
                   GROUP BY m.device, m.brightness`
    );
    const deviceRows = await filteredRows<DeviceRow>(
      client,
      filters,
      ["device"],
      (where) => `SELECT m.device, count(*)::int AS image_count
                    FROM metadata m
                   WHERE ${where}
                   GROUP BY m.device`
    );
    const brightnessRows = await filteredRows<BrightnessRow>(
      client,
      filters,
      ["brightness"],
      (where) => `SELECT m.brightness, count(*)::int AS image_count
                    FROM metadata m
                   WHERE ${where}
                   GROUP BY m.brightness`
    );
    const themeRows = await filteredRows<FacetCountRow>(
      client,
      filters,
      ["theme"],
      (where) => `SELECT t.slug,
                          t.display_name,
                          count(m.id)::int AS image_count
                     FROM theme t
                     LEFT JOIN metadata m
                       ON m.theme=t.slug
                      AND ${where}
                    GROUP BY t.slug, t.display_name, t.sort_order
                    ORDER BY (t.slug='none') DESC, t.sort_order ASC, t.slug ASC`
    );
    const tagRows = await filteredRows<FacetCountRow>(
      client,
      filters,
      ["tag"],
      (where) => `SELECT t.slug,
                          t.display_name,
                          count(DISTINCT m.id)::int AS image_count
                     FROM tag t
                     LEFT JOIN image_tag facet_it ON facet_it.tag_slug=t.slug
                     LEFT JOIN metadata m
                       ON m.id=facet_it.image_id
                      AND ${where}
                    GROUP BY t.slug, t.display_name, t.sort_order
                    ORDER BY t.sort_order ASC, t.slug ASC`
    );
    const authorRows = await filteredRows<AuthorCountRow>(
      client,
      filters,
      ["author"],
      (where) => `SELECT a.slug,
                          a.display_name,
                          a.link,
                          count(m.id)::int AS image_count
                     FROM author a
                     LEFT JOIN metadata m
                       ON m.author=a.slug
                      AND ${where}
                    GROUP BY a.slug, a.display_name, a.link, a.sort_order
                    ORDER BY a.sort_order ASC, a.slug ASC`
    );

    await client.query("COMMIT");

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
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getPublicGalleryStats(
  query: GalleryStatsQuery = {}
): Promise<GalleryStatsDto> {
  const filters = parseStatsFilters(query);
  const revision = await imageCacheRevision();
  const cacheKey = galleryStatsCacheKey(filters);
  if (revision === null) {
    return coalesce(
      `gallery-stats:uncached:${cacheKey}`,
      () => readPublicGalleryStats(filters)
    );
  }

  const cached = await getGalleryStatsCache<GalleryStatsDto>(
    cacheKey,
    revision
  );
  if (cached.status === "hit") return cached.value;
  if (cached.status === "unavailable") {
    return coalesce(
      `gallery-stats:uncached:${revision}:${cacheKey}`,
      () => readPublicGalleryStats(filters)
    );
  }

  return coalesce(
    `gallery-stats:${revision ?? "uncached"}:${cacheKey}`,
    async () => {
      const raced = await getGalleryStatsCache<GalleryStatsDto>(
        cacheKey,
        revision
      );
      if (raced.status === "hit") return raced.value;

      const stats = await readPublicGalleryStats(filters);
      if (raced.status === "miss") {
        await setGalleryStatsCache(cacheKey, stats, revision);
      }
      return stats;
    }
  );
}
