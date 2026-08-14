import type { AdminOverviewDto } from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { pool } from "../../core/database-pools.ts";
import {
  getReadyImageCacheOverviewStatus
} from "../ready-cache/admin-status.ts";
import {
  adminImageDetailItemsWithTags,
  adminImageDetailPresentationColumnsWithTags,
  type AdminImageDetailRecordWithTags
} from "../presenter.ts";

export async function getOverviewStats(): Promise<AdminOverviewDto> {
  const recentLimit = getRuntimeConfig().admin.recent_uploads;
  return buildOverviewStats(recentLimit);
}

async function buildOverviewStats(
  recentLimit: number
): Promise<AdminOverviewDto> {
  const [
    statsResult,
    topThemesResult,
    recentResult,
    backendResult,
    readyImageCache
  ] = await Promise.all([
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
      `SELECT ${adminImageDetailPresentationColumnsWithTags},
              COALESCE((
                SELECT sb.display_name
                  FROM storage_backend sb
                 WHERE sb.slug = metadata.storage_slug
              ), '') AS storage_display_name
         FROM metadata
        WHERE status='ready'
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      [recentLimit]
    ),
    pool.query("SELECT count(*)::int AS n FROM storage_backend"),
    getReadyImageCacheOverviewStatus()
  ]);

  const row = statsResult.rows[0];
  const recent = await adminImageDetailItemsWithTags(
    recentResult.rows as AdminImageDetailRecordWithTags[]
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
    recent,
    redis_cache: {
      state: readyImageCache.state,
      synchronized: readyImageCache.synchronized,
      rebuilding: readyImageCache.rebuilding,
      item_count: readyImageCache.item_count,
      last_full_rebuild_core_memory_bytes:
        readyImageCache.last_full_rebuild_core_memory_bytes,
      last_full_rebuild_measured_at:
        readyImageCache.last_full_rebuild_measured_at
    }
  };
}
