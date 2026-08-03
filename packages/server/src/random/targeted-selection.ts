import type {
  Brightness,
  Device,
  RandomMethod
} from "@imageshow/shared/browser";
import { pool } from "../core/db.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import type { PickedImage } from "./picker.ts";

export async function pickTargetedImage(
  ids: string[],
  method: RandomMethod,
  signal?: AbortSignal
): Promise<PickedImage | Response> {
  signal?.throwIfAborted();
  const fullIds = ids.filter((id) => id.length > 12);
  const suffixes = ids.filter((id) => id.length === 12);
  const rows = (await pool.query(
    `WITH candidate_ids AS (
       SELECT id
         FROM metadata
        WHERE status = 'ready' AND id = ANY($1::uuid[])
       UNION
       SELECT id
         FROM metadata
        WHERE status = 'ready' AND RIGHT(id::text, 12) = ANY($2::text[])
     )
     SELECT m.id, m.object_key, m.ext, m.device, m.brightness, m.theme,
            m.storage_slug
       FROM metadata m
       JOIN candidate_ids candidate ON candidate.id = m.id
      ORDER BY m.id`,
    [fullIds, suffixes]
  )).rows;
  signal?.throwIfAborted();
  const candidates: PickedImage[] = rows.map((row) => ({
    id: String(row.id),
    object_key: String(row.object_key),
    ext: String(row.ext),
    device: row.device as Device,
    brightness: row.brightness as Brightness,
    theme: String(row.theme),
    storage_slug: String(row.storage_slug),
    method
  }));
  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  if (!picked) {
    return apiErrorResponse({
      status: 404,
      message: "Not Found: No available images for the requested ids"
    });
  }
  return picked;
}
