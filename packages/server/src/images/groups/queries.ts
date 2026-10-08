import type { ImageGroupDto } from "@imageshow/shared/browser";
import { pool } from "../../core/database/pools.ts";

export async function listImageGroups(): Promise<ImageGroupDto[]> {
  return (await pool.query<ImageGroupDto>(
    `SELECT g.slug, g.display_name, g.sort_order, count(m.id)::int AS image_count
       FROM image_group g
       LEFT JOIN image_group_member member ON member.group_slug=g.slug
       LEFT JOIN metadata m ON m.id=member.image_id AND m.status='ready'
      GROUP BY g.slug ORDER BY g.sort_order DESC, g.created_at DESC, g.slug`
  )).rows;
}
