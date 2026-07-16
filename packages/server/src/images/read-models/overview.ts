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
  const generation = await publicImagesCacheGeneration();
  const cacheKey = `v2:${generation}`;
  const cached = await getAdminOverviewCache<OverviewStats>(cacheKey);
  if (cached) return cached;

  return coalesce(`admin-overview:${cacheKey}`, async () => {
    const raced = await getAdminOverviewCache<OverviewStats>(cacheKey);
    if (raced) return raced;

    const stats = await buildOverviewStats();
    await setAdminOverviewCache(cacheKey, stats);
    return stats;
  });
}

async function buildOverviewStats() {
  const recentLimit = getRuntimeConfig().admin.recent_uploads;
  const [statsResult, topThemesResult, recentResult, backendResult] = await Promise.all([
    pool.query(`
      SELECT
        count(*) FILTER (WHERE status='ready')::int AS gallery,
        count(*) FILTER (WHERE status='ready' AND theme='none')::int AS theme_unset,
        count(*) FILTER (WHERE status='deleted')::int AS trash,
        count(*)::int AS total,
        count(*) FILTER (WHERE NOT m.is_link AND sb.type='local')::int AS local,
        count(*) FILTER (WHERE NOT m.is_link AND sb.type<>'local')::int AS nonlocal,
        count(*) FILTER (WHERE m.is_link)::int AS link_count,
        COALESCE(sum(image_size) FILTER (WHERE NOT m.is_link AND sb.type='local'), 0)::bigint AS local_image_size,
        COALESCE(sum(thumbnail_size) FILTER (WHERE NOT m.is_link AND sb.type='local'), 0)::bigint AS local_thumb_size,
        COALESCE(sum(image_size) FILTER (WHERE NOT m.is_link AND sb.type<>'local'), 0)::bigint AS nonlocal_image_size,
        COALESCE(sum(thumbnail_size) FILTER (WHERE NOT m.is_link AND sb.type<>'local'), 0)::bigint AS nonlocal_thumb_size,
        COALESCE(sum(thumbnail_size) FILTER (WHERE m.is_link AND sb.type='local'), 0)::bigint AS link_local_size,
        COALESCE(sum(thumbnail_size) FILTER (WHERE m.is_link AND sb.type<>'local'), 0)::bigint AS link_nonlocal_size,
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
      `SELECT id, device, brightness, theme, ext, object_key, storage_slug, is_link, title
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
    link_count: row.link_count,
    local_image_size: Number(row.local_image_size),
    local_thumb_size: Number(row.local_thumb_size),
    nonlocal_image_size: Number(row.nonlocal_image_size),
    nonlocal_thumb_size: Number(row.nonlocal_thumb_size),
    link_local_size: Number(row.link_local_size),
    link_nonlocal_size: Number(row.link_nonlocal_size),
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
