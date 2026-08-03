import type {
  Brightness,
  Device,
  RandomImageJsonItemDto
} from "@imageshow/shared/browser";
import { pool } from "../core/db.ts";
import { publicImageUrls } from "../storage/public-urls.ts";
import type { PickedImage } from "./picker.ts";

type RandomJsonRow = {
  id: string;
  object_key: string;
  storage_slug: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  tags: string[];
  width: number | string;
  height: number | string;
  image_time: Date | string;
};

function imageTimeIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function presentRandomJsonItems(
  picked: PickedImage[],
  signal?: AbortSignal
): Promise<RandomImageJsonItemDto[]> {
  const ids = [...new Set(picked.map((item) => item.id))];
  if (!ids.length) return [];

  signal?.throwIfAborted();
  const rows = (await pool.query(
    `WITH selected AS (
       SELECT id, position
         FROM unnest($1::uuid[]) WITH ORDINALITY AS input(id, position)
     )
     SELECT m.id, m.object_key, m.storage_slug, m.device, m.brightness,
            m.theme, m.width, m.height, m.image_time,
            ARRAY(
              SELECT it.tag_slug
                FROM image_tag it
               WHERE it.image_id = m.id
               ORDER BY it.tag_slug
            ) AS tags
       FROM selected
       JOIN metadata m ON m.id = selected.id
      WHERE m.status = 'ready'
      ORDER BY selected.position`,
    [ids]
  )).rows as RandomJsonRow[];
  signal?.throwIfAborted();

  return Promise.all(rows.map(async (row) => ({
    id: String(row.id),
    ...await publicImageUrls(String(row.object_key), String(row.storage_slug)),
    device: row.device,
    brightness: row.brightness,
    theme: String(row.theme),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    width: Number(row.width),
    height: Number(row.height),
    image_time: imageTimeIso(row.image_time)
  })));
}
