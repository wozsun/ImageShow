import {
  imageGroupMembershipLimit,
  type ImageGroupAddResponseDto,
  type ImageGroupAddResultDto
} from "@imageshow/shared/browser";
import { imageGroupLockRequest } from "./locks.ts";
import { withGroupSlugCacheInvalidation } from "./slug-cache.ts";
import { ApiError } from "../../core/api-error.ts";
import { withAdvisoryLocks } from "../../core/database/advisory-locks.ts";
import { pool } from "../../core/database/pools.ts";
import { withTransaction } from "../../core/database/transactions.ts";
import { normalizedUuidSchema } from "../../core/uuid.ts";
import { imageUpdateLockRequests } from "../image-update-lock.ts";
import { withImageMutationSync } from "../mutation-sync.ts";
import { bumpReadyImageRevision } from "../ready-cache/revision.ts";


function assertGroupFound(count: number | null) {
  if (!count) throw new ApiError(404, "not_found", "分组不存在");
}

export async function createImageGroup(slug: string, displayName: string, sortOrder = 0) {
  await withGroupSlugCacheInvalidation(() => withAdvisoryLocks([imageGroupLockRequest(slug)], async (signal) => {
    signal.throwIfAborted();
    const result = await pool.query(
      `INSERT INTO image_group(slug, display_name, sort_order) VALUES($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING slug`, [slug, displayName, sortOrder]
    );
    if (!result.rowCount) throw new ApiError(409, "conflict", "分组已存在");
  }));
}

export async function renameImageGroup(slug: string, displayName: string) {
  const result = await pool.query(
    "UPDATE image_group SET display_name=$2, updated_at=now() WHERE slug=$1",
    [slug, displayName]
  );
  assertGroupFound(result.rowCount);
}

export async function setImageGroupSortOrder(slug: string, sortOrder: number) {
  const result = await pool.query(
    "UPDATE image_group SET sort_order=$2, updated_at=now() WHERE slug=$1",
    [slug, sortOrder]
  );
  assertGroupFound(result.rowCount);
}

export async function addImageGroupMembers(slug: string, inputs: string[]): Promise<ImageGroupAddResponseDto> {
  const parsed = inputs.map((id) => normalizedUuidSchema.safeParse(id.trim()));
  const ids = [...new Set(parsed.flatMap((value) => value.success ? [value.data] : []))];
  return withAdvisoryLocks(
    [imageGroupLockRequest(slug, "shared"), ...imageUpdateLockRequests(ids)],
    (signal) => withImageMutationSync(async (batch) => {
      const mutation = await withTransaction(async (client) => {
        signal.throwIfAborted();
        assertGroupFound((await client.query("SELECT slug FROM image_group WHERE slug=$1", [slug])).rowCount);
        const images = (await client.query<{ id: string; member: boolean; memberships: number }>(
          `SELECT m.id,
                  EXISTS(SELECT 1 FROM image_group_member WHERE image_id=m.id AND group_slug=$2) AS member,
                  (SELECT count(*)::int FROM image_group_member WHERE image_id=m.id) AS memberships
             FROM metadata m WHERE m.id=ANY($1::uuid[]) AND m.status='ready'`, [ids, slug]
        )).rows;
        const byId = new Map(images.map((image) => [image.id, image]));
        const added: string[] = [];
        const items: ImageGroupAddResultDto[] = parsed.map((value, index) => {
          if (!value.success) return { id: inputs[index]!, status: "invalid_id" };
          const id = value.data;
          const image = byId.get(id);
          if (!image) return { id, status: "not_found" };
          if (image.member) return { id, status: "already_member" };
          if (image.memberships >= imageGroupMembershipLimit) return { id, status: "group_limit" };
          image.member = true;
          added.push(id);
          return { id, status: "added" };
        });
        if (added.length) {
          await client.query(
            "INSERT INTO image_group_member(group_slug, image_id) SELECT $1, unnest($2::uuid[])", [slug, added]
          );
          await bumpReadyImageRevision(client);
        }
        signal.throwIfAborted();
        return { items, added };
      });
      for (const id of mutation.added) batch.add({ id });
      return { items: mutation.items };
    })
  );
}

export async function removeImageGroupMembers(slug: string, ids: string[]) {
  return withAdvisoryLocks(
    [imageGroupLockRequest(slug, "shared"), ...imageUpdateLockRequests(ids)],
    (signal) => withImageMutationSync(async (batch) => {
      const result = await withTransaction(async (client) => {
        signal.throwIfAborted();
        assertGroupFound((await client.query("SELECT slug FROM image_group WHERE slug=$1", [slug])).rowCount);
        const removed = await client.query<{ id: string; ready: boolean }>(
          `WITH removed AS (
             DELETE FROM image_group_member WHERE group_slug=$1 AND image_id=ANY($2::uuid[]) RETURNING image_id
           ) SELECT m.id, m.status='ready' AS ready FROM removed JOIN metadata m ON m.id=removed.image_id`,
          [slug, ids]
        );
        const affected = removed.rows.filter((image) => image.ready);
        if (affected.length) await bumpReadyImageRevision(client);
        signal.throwIfAborted();
        return { affected, removed: removed.rowCount ?? 0 };
      });
      for (const image of result.affected) batch.add(image);
      return { removed: result.removed };
    })
  );
}

export async function deleteImageGroup(slug: string) {
  await withGroupSlugCacheInvalidation(() => withAdvisoryLocks([imageGroupLockRequest(slug)], (signal) =>
    withImageMutationSync(async (batch) => {
      const affected = await withTransaction(async (client) => {
        signal.throwIfAborted();
        const from = `FROM image_group_member member JOIN metadata m ON m.id=member.image_id
                       WHERE member.group_slug=$1 AND m.status='ready'`;
        const count = Number((await client.query(`SELECT count(*)::int AS count ${from}`, [slug])).rows[0].count);
        const decision = batch.decide(count);
        const images = decision.mode === "exact"
          ? (await client.query<{ id: string }>(`SELECT m.id ${from}`, [slug])).rows : [];
        assertGroupFound((await client.query("DELETE FROM image_group WHERE slug=$1", [slug])).rowCount);
        if (count) await bumpReadyImageRevision(client);
        signal.throwIfAborted();
        return images;
      });
      for (const image of affected) batch.add(image);
    })
  ));
}
