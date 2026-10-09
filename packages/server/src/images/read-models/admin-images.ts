import type {
  AdminImageListResponseDto,
  AdminImageSort,
  Brightness,
  Device,
  ImageSnapshotResponseDto,
  ImageAdminInfoDto
} from "@imageshow/shared/browser";
import { defaultAdminImageSort } from "@imageshow/shared/browser";
import { pool } from "../../core/database/pools.ts";
import { withReadOnlyRepeatableReadTransaction } from "../../core/database/transactions.ts";
import {
  runWithAdvisoryLockAcquisitionSignal,
  withAdvisoryLocks
} from "../../core/database/advisory-locks.ts";
import { ApiError } from "../../core/api-error.ts";
import { imageGroupLockRequest } from "../groups/locks.ts";
import { imageUpdateLockRequests } from "../image-update-lock.ts";
import { resolveImageFilterPlan } from "../filter-plan.ts";
import { readReadyImagePageWindow } from "../ready-cache/query.ts";
import { createPageWindow } from "../page-window.ts";
import {
  adminImageListItemsWithTags,
  editableImagePresentationColumnsWithTags,
  editableImageSnapshotsWithTags,
  imageAdminInfoPresentationColumns,
  imageAdminInfo,
  type ImageAdminInfoRecord,
  type EditableImageSnapshotRecordWithTags
} from "../presenter.ts";
import {
  buildImageListFilters,
  buildResolvedReadyImageListFilters
} from "./list-filters.ts";
import { fetchAdminImageOffsetRows } from "./pagination.ts";

export type AdminImageListQuery = {
  status: "ready" | "deleted";
  device?: Device;
  brightness?: Brightness;
  theme?: string;
  tag?: string | string[];
  author?: string;
  group?: string;
  mark_group?: string;
  page: number;
  limit: number;
} & Partial<AdminImageSort>;

export async function listAdminImages(
  query: AdminImageListQuery
): Promise<AdminImageListResponseDto> {
  const groupSlugs = [...new Set(
    [query.group, query.mark_group].filter((slug): slug is string => Boolean(slug))
  )].sort();
  if (!groupSlugs.length) return readAdminImagePage(query);
  // A lost write response can precede COMMIT. Establish the snapshot only after
  // the group's active shared membership locks have settled.
  return withAdvisoryLocks(groupSlugs.map((slug) => imageGroupLockRequest(slug)), async (signal) => {
    signal.throwIfAborted();
    const result = await readAdminImagePage(query);
    signal.throwIfAborted();
    return result;
  });
}

async function readAdminImagePage(query: AdminImageListQuery): Promise<AdminImageListResponseDto> {
  const window = createPageWindow(query.page, query.limit);
  const sort: AdminImageSort = {
    sort_by: query.sort_by ?? defaultAdminImageSort.sort_by,
    order: query.order ?? defaultAdminImageSort.order
  };
  let readyPlan: Awaited<ReturnType<typeof resolveImageFilterPlan>> | null = null;
  if (query.status === "ready") {
    readyPlan = await resolveImageFilterPlan(query, { redisMode: "required" });
    // The ready index is ordered by image_time. Entry time uses PostgreSQL's
    // authoritative order instead of reordering only the cached page.
    if (sort.sort_by === "image_time" && !query.group && !query.mark_group) {
      const cached = await readReadyImagePageWindow(readyPlan, window, sort.order);
      if (cached.status === "redis_unavailable") throw cached.error;
      if (cached.status === "hit") {
        const images = await adminImageListItemsWithTags(
          cached.value.items.map((item) => ({
            ...item,
            image_time: new Date(Math.floor(item.sort_score / 1_000)),
            status: "ready",
            deleted_at: null,
            purge_pending: false
          }))
        );
        return {
          items: images,
          total: cached.value.total
        };
      }
    }
  }
  const { params, where } = readyPlan
    ? buildResolvedReadyImageListFilters(readyPlan)
    : await buildImageListFilters(query, { redisMode: "required" });

  if (query.group) {
    params.push(query.group);
    where.push(`EXISTS(SELECT 1 FROM image_group_member member WHERE member.image_id=metadata.id AND member.group_slug=$${params.length})`);
  }
  const snapshot = await withReadOnlyRepeatableReadTransaction(async (client) => {
    const countResult = await client.query(
      `SELECT count(*)::text AS count FROM metadata WHERE ${where.join(" AND ")}`,
      [...params]
    );
    const total = Number(countResult.rows[0]?.count ?? 0);
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new Error("PostgreSQL returned an invalid image count");
    }
    const rows =
      window.start >= total
        ? []
        : await fetchAdminImageOffsetRows(
            [...where],
            [...params],
            window,
            client,
            sort
          );
    const members = query.mark_group && rows.length
      ? (await client.query<{ image_id: string }>(
          "SELECT image_id FROM image_group_member WHERE group_slug=$1 AND image_id=ANY($2::uuid[])",
          [query.mark_group, rows.map((row) => row.id)]
        )).rows : [];
    return { rows, total, memberIds: new Set(members.map((member) => member.image_id)) };
  });
  return {
    items: (await adminImageListItemsWithTags(snapshot.rows)).map((item) =>
      query.mark_group ? { ...item, in_group: snapshot.memberIds.has(item.id) } : item
    ),
    total: snapshot.total
  };
}

export async function getAdminImageSnapshots(
  ids: string[],
  signal: AbortSignal,
  markGroup?: string
): Promise<ImageSnapshotResponseDto> {
  const canonicalIds = [...new Set(ids.map((id) => id.toLowerCase()))];
  const locks = [
    ...(markGroup ? [imageGroupLockRequest(markGroup)] : []),
    ...imageUpdateLockRequests(canonicalIds)
  ];
  const read = () =>
    withAdvisoryLocks(locks, async () => {
      signal.throwIfAborted();
      const result = await pool.query(
        `SELECT ${editableImagePresentationColumnsWithTags}${markGroup ? `,
                EXISTS(SELECT 1 FROM image_group_member member
                        WHERE member.image_id=metadata.id AND member.group_slug=$2) AS in_group` : ""}
           FROM metadata
          WHERE id = ANY($1::uuid[])
            AND status = 'ready'`,
        markGroup ? [canonicalIds, markGroup] : [canonicalIds]
      );
      signal.throwIfAborted();
      // Metadata, tags and optional membership come from one SQL statement, so this is an
      // authoritative point-in-time projection even if another admin mutates
      // the image immediately before or after the snapshot.
      const projected = await editableImageSnapshotsWithTags(
        result.rows as EditableImageSnapshotRecordWithTags[]
      );
      signal.throwIfAborted();
      const itemsById = new Map(projected.map((item) => [item.id, item]));
      const memberIds = new Set(result.rows.filter((row) => row.in_group).map((row) => row.id));
      return {
        items: canonicalIds.flatMap((id) => {
          const item = itemsById.get(id);
          return item ? [markGroup ? { ...item, in_group: memberIds.has(id) } : item] : [];
        })
      };
    });
  return runWithAdvisoryLockAcquisitionSignal(signal, read);
}

export async function getAdminImageInfo(id: string): Promise<ImageAdminInfoDto> {
  const row = (
    await pool.query(
      `SELECT ${imageAdminInfoPresentationColumns}
       FROM metadata
      WHERE id=$1
      LIMIT 1`,
      [id]
    )
  ).rows[0] as ImageAdminInfoRecord | undefined;
  if (!row) throw new ApiError(404, "not_found", "Image not found");
  return imageAdminInfo(row);
}
