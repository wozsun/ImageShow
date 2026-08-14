import type { z } from "zod";
import type {
  AdminImageListResponseDto,
  ImageSnapshotResponseDto,
  ImageAdminInfoDto
} from "@imageshow/shared/browser";
import { pool } from "../../core/database-pools.ts";
import {
  withReadOnlyRepeatableReadTransaction
} from "../../core/database-transactions.ts";
import { withAdvisoryLocks } from "../../core/database-advisory-locks.ts";
import { ApiError } from "../../core/api-error.ts";
import { adminImageListQuery } from "../../core/validation.ts";
import { imageUpdateLockRequests } from "../image-update-lock.ts";
import { resolveImageFilterPlan } from "../filter-plan.ts";
import { readReadyImagePageWindow } from "../ready-cache/query.ts";
import { createPageWindow } from "../page-window.ts";
import {
  adminImageListItemsWithTags,
  editableImagePresentationColumnsWithTags,
  editableImageSnapshotsWithTags,
  type EditableImageSnapshotRecordWithTags
} from "../presenter.ts";
import {
  buildImageListFilters,
  buildResolvedReadyImageListFilters
} from "./list-filters.ts";
import { fetchAdminImageOffsetRows } from "./pagination.ts";
import { storageBackendLabel } from "../../storage/backend-label.ts";

type AdminImageListQuery = z.infer<typeof adminImageListQuery>;

export async function listAdminImages(
  query: AdminImageListQuery
): Promise<AdminImageListResponseDto> {
  const window = createPageWindow(query.page, query.limit);
  let readyPlan: Awaited<ReturnType<typeof resolveImageFilterPlan>>
    | null = null;
  if (query.status === "ready") {
    readyPlan = await resolveImageFilterPlan(query, { redisMode: "required" });
    const cached = await readReadyImagePageWindow(
      readyPlan,
      window
    );
    if (cached.status === "redis_unavailable") throw cached.error;
    if (cached.status === "hit") {
      const images = await adminImageListItemsWithTags(cached.value.items.map((item) => ({
        ...item,
        status: "ready",
        deleted_at: null
      })));
      return {
        items: images,
        total: cached.value.total
      };
    }
  }
  const { params, where } = readyPlan
    ? buildResolvedReadyImageListFilters(readyPlan)
    : await buildImageListFilters(query, { redisMode: "required" });

  const snapshot = await withReadOnlyRepeatableReadTransaction(
    async (client) => {
      const countResult = await client.query(
        `SELECT count(*)::text AS count FROM metadata WHERE ${where.join(" AND ")}`,
        [...params]
      );
      const total = Number(countResult.rows[0]?.count ?? 0);
      if (!Number.isSafeInteger(total) || total < 0) {
        throw new Error("PostgreSQL returned an invalid image count");
      }
      const rows = window.start >= total
        ? []
        : await fetchAdminImageOffsetRows(
            [...where],
            [...params],
            window,
            client
          );
      return { rows, total };
    }
  );
  return {
    items: await adminImageListItemsWithTags(snapshot.rows),
    total: snapshot.total
  };
}

export async function getAdminImageSnapshots(
  ids: string[]
): Promise<ImageSnapshotResponseDto> {
  const canonicalIds = [...new Set(ids.map((id) => id.toLowerCase()))];
  return withAdvisoryLocks(
    imageUpdateLockRequests(canonicalIds),
    async () => {
      const result = await pool.query(
        `SELECT ${editableImagePresentationColumnsWithTags}
           FROM metadata
          WHERE id = ANY($1::uuid[])
            AND status = 'ready'`,
        [canonicalIds]
      );
      // Metadata and tags come from one SQL statement, so this is an
      // authoritative point-in-time projection even if another admin mutates
      // the image immediately before or after the snapshot.
      const projected = await editableImageSnapshotsWithTags(
        result.rows as EditableImageSnapshotRecordWithTags[]
      );
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
    storage_label: storageBackendLabel(row),
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? ""
  };
}
