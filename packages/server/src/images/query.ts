import type { z } from "zod";
import { pool } from "../core/db.js";
import { ApiError } from "../core/http.js";
import { getRuntimeConfig } from "../config/env.js";
import { adminImageListQuery, listQuery } from "../core/validation.js";
import { splitSelectors } from "../core/selectors.js";
import { decodeImageCursor, encodeImageCursor } from "./cursor.js";
import { adminImageView, cacheImageLookups, publicImage, publicImages, publicImagesCacheKey, publicListImage, type ImageRecord, type PublicImage, type PublicListImage } from "./presenter.js";
import { getGalleryFacetsCache, getGalleryOptions, getMd5Cache, getPublicImagesCache, getThemeVocab, publicImagesCacheGeneration, setGalleryFacetsCache, setMd5Cache, setPublicImagesCache } from "../core/redis.js";
import { resolveThemeSlugs } from "../themes/query.js";
import { resolveTagNames } from "../tags/query.js";
import { resolveAuthorSlugs } from "../authors/query.js";

type FacetOption = { slug: string; display_name: string };

type AuthorOption = { slug: string; display_name: string; link: string };
type GalleryFacets = { devices: string[]; brightnesses: string[]; themes: FacetOption[]; tags: FacetOption[]; authors: AuthorOption[] };

type AdminImageListQuery = z.infer<typeof adminImageListQuery>;
type PublicListQuery = z.infer<typeof listQuery>;
type PublicImagesPayload = { items: PublicListImage[]; limit: number; has_next: boolean; next_cursor: string | null; total: null };

async function fetchImagePage(where: string[], params: unknown[], limit: number, cursor?: string) {
  if (cursor) {
    const decoded = decodeImageCursor(cursor);
    params.push(decoded.createdAt, decoded.id);
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const result = await pool.query(
    `SELECT *, created_at::text AS cursor_created_at FROM metadata WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params
  );
  const visibleRows = result.rows.slice(0, limit) as Array<ImageRecord & { id: string; cursor_created_at: string }>;
  const hasNext = result.rows.length > limit;
  const last = visibleRows.at(-1);
  const items = await publicImages(visibleRows);
  return { items, hasNext, nextCursor: hasNext && last ? encodeImageCursor(last) : null };
}

export async function listAdminImages(q: AdminImageListQuery) {
  const limit = q.limit;
  const params: unknown[] = [q.status];
  const where = ["status = $1"];
  if (q.d) { params.push(q.d); where.push(`device = $${params.length}`); }
  if (q.b) { params.push(q.b); where.push(`brightness = $${params.length}`); }

  if (q.t) { params.push(await resolveThemeSlugs([q.t])); where.push(`theme = ANY($${params.length}::text[])`); }

  const [countResult, page] = await Promise.all([
    pool.query(`SELECT count(*)::int AS count FROM metadata WHERE ${where.join(" AND ")}`, [...params]),
    fetchImagePage([...where], [...params], limit, q.cursor)
  ]);
  const total = Number(countResult.rows[0]?.count ?? 0);

  return { items: page.items.map(adminImageView), limit, total, has_next: page.hasNext, next_cursor: page.nextCursor };
}

function withShuffle(q: PublicListQuery, payload: PublicImagesPayload): PublicImagesPayload {
  if (!q.shuffle || payload.items.length < 2) return payload;
  const items = [...payload.items];
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return { ...payload, items };
}

async function selectorFilter(
  rawValue: string,
  params: unknown[],
  resolve: (terms: string[]) => Promise<string[]>,
  noun: string,
  clause: (paramIndex: number, exclude: boolean) => string
): Promise<string> {
  const { include, exclude } = splitSelectors([rawValue]);
  if (include.length && exclude.length) throw new ApiError(400, "validation_error", `Cannot mix include and exclude ${noun} selectors`);
  const isExclude = exclude.length > 0;
  params.push(await resolve(isExclude ? exclude : include));
  return clause(params.length, isExclude);
}

const PUBLIC_LIST_SHAPE_VERSION = "s3";

export async function listPublicImages(q: PublicListQuery): Promise<PublicImagesPayload> {
  const limit = q.limit ?? getRuntimeConfig().site.gallery.default_limit;

  const generation = await publicImagesCacheGeneration();
  const cacheKey = `v${generation}:${PUBLIC_LIST_SHAPE_VERSION}:${publicImagesCacheKey({ ...q, limit })}`;
  const cached = await getPublicImagesCache<PublicImagesPayload>(cacheKey);
  if (cached) return withShuffle(q, cached);
  const params: unknown[] = [q.status];
  const where = ["status = $1"];
  if (q.d) { params.push(q.d); where.push(`device = $${params.length}`); }
  if (q.b) { params.push(q.b); where.push(`brightness = $${params.length}`); }

  if (q.t) where.push(await selectorFilter(q.t, params, resolveThemeSlugs, "theme",
    (index, exclude) => exclude ? `NOT (theme = ANY($${index}::text[]))` : `theme = ANY($${index}::text[])`));
  if (q.tag) where.push(await selectorFilter(q.tag, params, resolveTagNames, "tag",
    (index, exclude) => exclude
      ? `NOT (id IN (SELECT image_id FROM image_tag WHERE tag_slug = ANY($${index}::text[])))`
      : `id IN (SELECT image_id FROM image_tag WHERE tag_slug = ANY($${index}::text[]))`));

  if (q.a) where.push(await selectorFilter(q.a, params, resolveAuthorSlugs, "author",
    (index, exclude) => exclude ? `(author IS NULL OR NOT (author = ANY($${index}::text[])))` : `author = ANY($${index}::text[])`));
  const page = await fetchImagePage(where, params, limit, q.cursor);

  await cacheImageLookups(page.items);
  const payload: PublicImagesPayload = { items: page.items.map(publicListImage), limit, has_next: page.hasNext, next_cursor: page.nextCursor, total: null };
  await setPublicImagesCache(cacheKey, payload);
  return withShuffle(q, payload);
}

export async function getAdminImage(id: string) {
  const result = await pool.query("SELECT * FROM metadata WHERE id=$1", [id]);
  if (!result.rows[0]) throw new ApiError(404, "not_found", "Image not found");
  return adminImageView(await publicImage(result.rows[0] as ImageRecord));
}

export async function checkImageMd5(md5: string) {
  const cached = await getMd5Cache(md5) as PublicImage[] | null;
  if (cached) return { md5, exists: cached.length > 0, items: cached.map(adminImageView) };
  const rows = await publicImages((await pool.query(
    "SELECT * FROM metadata WHERE md5=$1 ORDER BY status ASC, created_at DESC LIMIT 20",
    [md5]
  )).rows as ImageRecord[]);
  await setMd5Cache(md5, rows);
  return { md5, exists: rows.length > 0, items: rows.map(adminImageView) };
}

export async function getOverviewStats() {
  const recentLimit = getRuntimeConfig().admin.recent_uploads;

  const [statsResult, topThemesResult, recentResult, backendResult] = await Promise.all([
    pool.query(`
    SELECT
      count(*) FILTER (WHERE status='ready')::int AS gallery,
      count(*) FILTER (WHERE status='ready' AND theme='none')::int AS theme_unset,
      count(*) FILTER (WHERE status='deleted')::int AS trash,
      count(*)::int AS total,
      -- 普通图片按本地 / 非本地后端拆分；链接图片单独成组。
      -- 普通图的原图和缩略图都归属 storage_slug，回收站状态也要计入，
      -- 因为真正清除前对象仍占用该后端空间。
      -- 链接图只保存缩略图，同样按其 storage_slug 统计本地 / 非本地占用。
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
    pool.query("SELECT * FROM metadata WHERE status='ready' ORDER BY created_at DESC, id DESC LIMIT $1", [recentLimit]),
    pool.query("SELECT count(*)::int AS n FROM storage_backend")
  ]);
  const row = statsResult.rows[0];
  const topThemes = topThemesResult.rows;
  const recent = await publicImages(recentResult.rows as ImageRecord[]);
  const backendCount = backendResult.rows[0].n;
  return {
    gallery: row.gallery, theme_unset: row.theme_unset, trash: row.trash, total: row.total,
    local: row.local, nonlocal: row.nonlocal, link_count: row.link_count,
    local_image_size: Number(row.local_image_size), local_thumb_size: Number(row.local_thumb_size),
    nonlocal_image_size: Number(row.nonlocal_image_size), nonlocal_thumb_size: Number(row.nonlocal_thumb_size),
    link_local_size: Number(row.link_local_size), link_nonlocal_size: Number(row.link_nonlocal_size),
    theme_count: row.theme_count, backend_count: backendCount,
    pc: row.pc, mb: row.mb, dark: row.dark, light: row.light,
    top_themes: topThemes.map((t) => ({ theme: t.theme, count: t.count })),
    recent: recent.map((r) => ({ id: r.id, title: r.title, thumb_url: r.thumb_url, created_at: r.created_at }))
  };
}

export async function getPublicGalleryFacets(): Promise<GalleryFacets> {
  const cached = await getGalleryFacetsCache<GalleryFacets>();
  if (cached) return cached;
  const [base, themeVocab, tagResult, authorResult] = await Promise.all([
    getGalleryOptions(),
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
       WHERE EXISTS (SELECT 1 FROM metadata m WHERE m.author = a.slug AND m.status='ready')
       ORDER BY a.sort_order ASC, a.slug ASC`
    )
  ]);

  const themeNames = new Map(themeVocab.map((entry) => [entry.slug, entry.display_name]));
  const themes: FacetOption[] = base.themes.map((slug) => ({ slug, display_name: themeNames.get(slug) || "" }));
  const tags = tagResult.rows as FacetOption[];

  const authors = authorResult.rows as AuthorOption[];
  const facets: GalleryFacets = { devices: base.devices, brightnesses: base.brightnesses, themes, tags, authors };
  await setGalleryFacetsCache(facets);
  return facets;
}
