import type { z } from "zod";
import { pool } from "../../core/db.ts";
import { ApiError } from "../../core/http.ts";
import { adminImageListQuery } from "../../core/validation.ts";
import { resolveThemeSlugs } from "../../themes/query.ts";
import { warmCompleteImageLookups } from "../image-cache.ts";
import {
  adminImageView,
  publicImage,
  type ImageRecord
} from "../presenter.ts";
import { fetchAdminImagePage } from "./pagination.ts";

type AdminImageListQuery = z.infer<typeof adminImageListQuery>;

const storageBackendLabels: Record<string, string> = { local: "本地存储" };

function imageStorageLabel(row: {
  storage_slug: string;
  storage_display_name?: string | null;
  is_link?: boolean | null;
}) {
  if (row.is_link) return "外部链接";
  return row.storage_display_name?.trim()
    || storageBackendLabels[row.storage_slug]
    || row.storage_slug;
}

export async function listAdminImages(query: AdminImageListQuery) {
  const params: unknown[] = [query.status];
  const where = ["status = $1"];
  if (query.d) {
    params.push(query.d);
    where.push(`device = $${params.length}`);
  }
  if (query.b) {
    params.push(query.b);
    where.push(`brightness = $${params.length}`);
  }
  if (query.t) {
    params.push(await resolveThemeSlugs([query.t]));
    where.push(`theme = ANY($${params.length}::text[])`);
  }

  const [countResult, page] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS count FROM metadata WHERE ${where.join(" AND ")}`,
      [...params]
    ),
    fetchAdminImagePage([...where], [...params], query.limit, query.cursor)
  ]);
  await warmCompleteImageLookups(page.rows);
  return {
    items: page.items.map(adminImageView),
    limit: query.limit,
    total: Number(countResult.rows[0]?.count ?? 0),
    has_next: page.hasNext,
    next_cursor: page.nextCursor
  };
}

export async function getAdminImage(id: string) {
  const result = await pool.query("SELECT * FROM metadata WHERE id=$1", [id]);
  if (!result.rows[0]) throw new ApiError(404, "not_found", "Image not found");
  return adminImageView(await publicImage(result.rows[0] as ImageRecord));
}

export async function getAdminImageInfo(id: string) {
  const row = (await pool.query(
    `SELECT m.id,
            m.md5,
            m.storage_slug,
            m.is_link,
            m.image_time::text AS image_time,
            m.created_at::text AS created_at,
            m.updated_at::text AS updated_at,
            COALESCE(sb.display_name, '') AS storage_display_name
       FROM metadata m
       LEFT JOIN storage_backend sb ON sb.slug = m.storage_slug
      WHERE m.id=$1
      LIMIT 1`,
    [id]
  )).rows[0] as {
    id: string;
    md5: string;
    storage_slug: string;
    is_link: boolean;
    image_time: string;
    created_at: string;
    updated_at: string;
    storage_display_name: string;
  } | undefined;
  if (!row) throw new ApiError(404, "not_found", "Image not found");
  return {
    id: row.id,
    md5: row.md5,
    storage_label: imageStorageLabel(row),
    image_time: row.image_time ?? "",
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? ""
  };
}
