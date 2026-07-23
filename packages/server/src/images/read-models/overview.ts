import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { coalesce } from "../../core/coalesce.ts";
import { pool } from "../../core/db.ts";
import {
  getAdminOverviewCache,
  publicImagesCacheGeneration,
  setAdminOverviewCache
} from "../image-cache.ts";
import {
  overviewRecentImage,
  type OverviewRecentImageRecord
} from "../presenter.ts";

type OverviewStats = Awaited<ReturnType<typeof buildOverviewStats>>;

export async function getOverviewStats() {
  const recentLimit = getRuntimeConfig().admin.recent_uploads;
  const generation = await publicImagesCacheGeneration();
  const cacheKey = `recent:${recentLimit}`;
  const cached = await getAdminOverviewCache<OverviewStats>(cacheKey, generation);
  if (cached) return cached;

  return coalesce(
    `admin-overview:${generation ?? "uncached"}:${cacheKey}`,
    async () => {
      const raced = await getAdminOverviewCache<OverviewStats>(
        cacheKey,
        generation
      );
      if (raced) return raced;

      const stats = await buildOverviewStats(recentLimit);
      await setAdminOverviewCache(cacheKey, stats, generation);
      return stats;
    }
  );
}

async function buildOverviewStats(recentLimit: number) {
  const [statsResult, topThemesResult, recentResult, backendResult] = await Promise.all([
    pool.query(`
      SELECT
        count(*) FILTER (WHERE status='ready')::int AS gallery,
        count(*) FILTER (WHERE status='ready' AND theme='none')::int AS theme_unset,
        count(*) FILTER (WHERE status='deleted')::int AS trash,
        count(*)::int AS total,
        count(*) FILTER (WHERE sb.type='local')::int AS local,
        count(*) FILTER (WHERE sb.type<>'local')::int AS nonlocal,
        COALESCE(sum(image_size) FILTER (WHERE sb.type='local'), 0)::bigint AS local_image_size,
        COALESCE(sum(thumbnail_size) FILTER (WHERE sb.type='local'), 0)::bigint AS local_thumb_size,
        COALESCE(sum(image_size) FILTER (WHERE sb.type<>'local'), 0)::bigint AS nonlocal_image_size,
        COALESCE(sum(thumbnail_size) FILTER (WHERE sb.type<>'local'), 0)::bigint AS nonlocal_thumb_size,
        count(DISTINCT theme) FILTER (WHERE status='ready')::int AS theme_count,
        count(*) FILTER (WHERE status='ready' AND device='pc')::int AS pc,
        count(*) FILTER (WHERE status='ready' AND device='mb')::int AS mb,
        count(*) FILTER (WHERE status='ready' AND brightness='dark')::int AS dark,
        count(*) FILTER (WHERE status='ready' AND brightness='light')::int AS light
      FROM metadata m
      JOIN storage_backend sb ON sb.slug = m.storage_slug
    `),
    pool.query(`
      SELECT theme, count(*)::int AS count
      FROM metadata
      WHERE status='ready'
      GROUP BY theme
      ORDER BY count DESC, theme ASC
      LIMIT 8
    `),
    pool.query(
      `SELECT id, device, brightness, theme, ext, object_key, storage_slug, title
         FROM metadata
        WHERE status='ready'
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      [recentLimit]
    ),
    pool.query("SELECT count(*)::int AS n FROM storage_backend")
  ]);

  const row = statsResult.rows[0];
  const recent = await Promise.all(
    (recentResult.rows as OverviewRecentImageRecord[]).map(overviewRecentImage)
  );
  return {
    gallery: row.gallery,
    theme_unset: row.theme_unset,
    trash: row.trash,
    total: row.total,
    local: row.local,
    nonlocal: row.nonlocal,
    local_image_size: Number(row.local_image_size),
    local_thumb_size: Number(row.local_thumb_size),
    nonlocal_image_size: Number(row.nonlocal_image_size),
    nonlocal_thumb_size: Number(row.nonlocal_thumb_size),
    theme_count: row.theme_count,
    backend_count: backendResult.rows[0].n,
    pc: row.pc,
    mb: row.mb,
    dark: row.dark,
    light: row.light,
    top_themes: topThemesResult.rows.map((item) => ({
      theme: item.theme,
      count: item.count
    })),
    recent
  };
}
