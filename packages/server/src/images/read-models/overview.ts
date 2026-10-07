import type { AdminOverviewDto } from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { pool } from "../../core/database/pools.ts";
import { getReadyImageCacheOverviewStatus } from "../ready-cache/admin-status.ts";
import {
  adminImageDetailItemsWithTags,
  adminImageDetailPresentationColumnsWithTags,
  type AdminImageDetailRecordWithTags
} from "../presenter.ts";

export async function getOverviewStats(): Promise<AdminOverviewDto> {
  const recentLimit = getRuntimeConfig().admin.recent_uploads;
  const [statsResult, topThemesResult, recentResult, backendResult, readyImageCache] =
    await Promise.all([
      pool.query(`
      SELECT
        count(*) FILTER (WHERE status='ready')::int AS gallery,
        count(*)::int AS total,
        count(*) FILTER (WHERE sb.type='local')::int AS local,
        count(*) FILTER (WHERE sb.type<>'local')::int AS nonlocal,
        COALESCE(sum(l_byte_size) FILTER (WHERE sb.type='local'), 0)::bigint AS local_large_bytes,
        COALESCE(sum(s_byte_size) FILTER (WHERE sb.type='local'), 0)::bigint AS local_small_bytes,
        COALESCE(sum(m_byte_size) FILTER (WHERE sb.type='local'), 0)::bigint AS local_medium_bytes,
        COALESCE(sum(l_byte_size) FILTER (WHERE sb.type<>'local'), 0)::bigint AS nonlocal_large_bytes,
        COALESCE(sum(s_byte_size) FILTER (WHERE sb.type<>'local'), 0)::bigint AS nonlocal_small_bytes,
        COALESCE(sum(m_byte_size) FILTER (WHERE sb.type<>'local'), 0)::bigint AS nonlocal_medium_bytes,
        count(DISTINCT theme) FILTER (WHERE status='ready')::int AS theme_count,
        count(DISTINCT author) FILTER (WHERE status='ready')::int AS author_count,
        (SELECT count(DISTINCT it.tag_slug)::int
           FROM image_tag it
           JOIN metadata tagged ON tagged.id=it.image_id
          WHERE tagged.status='ready') AS tag_count,
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
      WHERE status='ready' AND theme IS NOT NULL
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
    total: row.total,
    local: row.local,
    nonlocal: row.nonlocal,
    local_large_bytes: Number(row.local_large_bytes),
    local_small_bytes: Number(row.local_small_bytes),
    local_medium_bytes: Number(row.local_medium_bytes),
    nonlocal_large_bytes: Number(row.nonlocal_large_bytes),
    nonlocal_small_bytes: Number(row.nonlocal_small_bytes),
    nonlocal_medium_bytes: Number(row.nonlocal_medium_bytes),
    theme_count: row.theme_count,
    tag_count: row.tag_count,
    author_count: row.author_count,
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
    ready_image_cache: {
      state: readyImageCache.state,
      synchronized: readyImageCache.synchronized,
      rebuilding: readyImageCache.rebuilding,
      item_count: readyImageCache.item_count,
      current_core_memory_bytes: readyImageCache.current_core_memory_bytes,
      current_core_measured_at: readyImageCache.current_core_measured_at,
      last_full_rebuild_core_memory_bytes: readyImageCache.last_full_rebuild_core_memory_bytes,
      last_full_rebuild_measured_at: readyImageCache.last_full_rebuild_measured_at
    }
  };
}
