import type { z } from "zod";
import type {
  AdminImageListResponseDto,
  BatchImageSnapshotResponseDto,
  ImageAdminInfoDto
} from "@imageshow/shared/browser";
import { pool } from "../../core/database-pools.ts";
import { withAdvisoryLocks } from "../../core/database-advisory-locks.ts";
import { ApiError } from "../../core/api-error.ts";
import { adminImageListQuery } from "../../core/validation.ts";
import { batchImageUpdateLockRequests } from "../batch-update-lock.ts";
import { resolveImageFilterPlan } from "../filter-plan.ts";
import { readReadyImagePage } from "../ready-cache/query.ts";
import {
  adminImageView,
  adminImagesWithTags,
  batchEditableImagePresentationColumnsWithTags,
  batchEditableImageSnapshotView,
  type ImageRecordWithTags
} from "../presenter.ts";
import {
  buildImageListFilters,
  buildResolvedReadyImageListFilters
} from "./list-filters.ts";
import { fetchAdminImagePage } from "./pagination.ts";

type AdminImageListQuery = z.infer<typeof adminImageListQuery>;

const storageBackendLabels: Record<string, string> = { local: "本地存储" };

function imageStorageLabel(row: {
  storage_slug: string;
  storage_display_name?: string | null;
}) {
  return row.storage_display_name?.trim()
    || storageBackendLabels[row.storage_slug]
    || row.storage_slug;
}

export async function listAdminImages(
  query: AdminImageListQuery
): Promise<AdminImageListResponseDto> {
  let readyPlan: Awaited<ReturnType<typeof resolveImageFilterPlan>>
    | null = null;
  if (query.status === "ready") {
    readyPlan = await resolveImageFilterPlan(query);
    const cached = await readReadyImagePage(
      readyPlan,
      query.limit,
      query.cursor
    );
    if (cached.cached) {
      const images = await adminImagesWithTags(cached.value.items.map((item) => ({
        ...item,
        status: "ready"
      })));
      return {
        items: images.map(adminImageView),
        total: cached.value.total,
        next_cursor: cached.value.nextCursor
      };
    }
  }
  const { params, where } = readyPlan
    ? buildResolvedReadyImageListFilters(readyPlan)
    : await buildImageListFilters(query);

  const [countResult, page] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS count FROM metadata WHERE ${where.join(" AND ")}`,
      [...params]
    ),
    fetchAdminImagePage([...where], [...params], query.limit, query.cursor)
  ]);
  return {
    items: page.items.map(adminImageView),
    total: Number(countResult.rows[0]?.count ?? 0),
    next_cursor: page.nextCursor
  };
}

export async function getAdminImageSnapshots(
  ids: string[]
): Promise<BatchImageSnapshotResponseDto> {
  const canonicalIds = [...new Set(ids.map((id) => id.toLowerCase()))];
  return withAdvisoryLocks(
    batchImageUpdateLockRequests(canonicalIds),
    async () => {
      const result = await pool.query(
        `SELECT ${batchEditableImagePresentationColumnsWithTags}
           FROM metadata
          WHERE id = ANY($1::uuid[])
            AND status = 'ready'`,
        [canonicalIds]
      );
      // Metadata and tags come from one SQL statement, so this is an
      // authoritative point-in-time projection even if another admin mutates
      // the image immediately before or after the snapshot.
      const projected = (await adminImagesWithTags(
        result.rows as ImageRecordWithTags[]
      ))
        .map(batchEditableImageSnapshotView);
      const itemsById = new Map(projected.map((item) => [item.id, item]));
      return {
        items: canonicalIds.flatMap((id) => {
          const item = itemsById.get(id);
          return item ? [item] : [];
        })
      };
    }
  );
}

export async function getAdminImageInfo(id: string): Promise<ImageAdminInfoDto> {
  const row = (await pool.query(
    `SELECT m.id,
            m.md5,
            m.storage_slug,
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
    created_at: string;
    updated_at: string;
    storage_display_name: string;
  } | undefined;
  if (!row) throw new ApiError(404, "not_found", "Image not found");
  return {
    id: row.id,
    md5: row.md5,
    storage_label: imageStorageLabel(row),
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? ""
  };
}
