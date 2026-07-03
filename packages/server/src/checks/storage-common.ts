import { thumbnailRef } from "../storage/image-paths.js";
import { listStorageBackends } from "../config/settings.js";

export type StorageRow = { id: string; object_key: string; status: string; storage_slug: string; is_link: boolean; device: string; brightness: string; theme: string };

export async function storageBackends() {
  const all = await listStorageBackends();
  const defaultBackend = (all.find((backend) => backend.is_default) ?? all.find((backend) => backend.slug === "local") ?? all[0])?.slug ?? "local";
  return { defaultBackend, backends: all.map((backend) => backend.slug) };
}

export function expectedThumbs(rows: StorageRow[]) {
  const thumbs = new Map<string, Set<string>>();
  const link = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.status !== "ready" && row.status !== "deleted") continue;
    const ref = thumbnailRef(row);
    const target = ref.prefix === "link" ? link : thumbs;
    let set = target.get(ref.slug);
    if (!set) { set = new Set<string>(); target.set(ref.slug, set); }
    set.add(ref.key);
  }
  return { thumbs, link };
}
