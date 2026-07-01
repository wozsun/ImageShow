import { thumbnailRef } from "../storage/image-paths.js";
import { listStorageBackends } from "../config/settings.js";

// A metadata row as the storage checks need it: identity, key, lifecycle status, the
// backend its bytes live in, whether it's an external link, and its category axes (link
// thumbnails are foldered by <device>-<brightness>/<theme>, so thumbnailRef needs them).
// Shared so check/cleanup agree on shape.
export type StorageRow = { id: string; object_key: string; status: string; storage_slug: string; is_link: boolean; device: string; brightness: string; theme: string };

// Real storage locations to inspect: every registered backend (so orphans in an empty
// or no-longer-default backend are still found), plus which one is the default.
export async function storageBackends() {
  const all = await listStorageBackends();
  const defaultBackend = (all.find((backend) => backend.is_default) ?? all.find((backend) => backend.slug === "local") ?? all[0])?.slug ?? "local";
  return { defaultBackend, backends: all.map((backend) => backend.slug) };
}

// Expected thumbnail keys grouped by the backend they live in, split by prefix:
// regular thumbnails under "thumbs" (beside their object) and link thumbnails under
// the top-level "link" prefix. A thumbnail exists for every stored image kept on disk — ready
// OR in the recycle bin (status='deleted'), since soft-delete no longer removes it — and for
// every link image. This is what tells a genuine orphan apart from a live (or recoverable)
// thumbnail, so cleanup never deletes one that a restore would need.
export function expectedThumbs(rows: StorageRow[]) {
  const thumbs = new Map<string, Set<string>>();
  const link = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.status !== "ready" && row.status !== "deleted" && !row.is_link) continue;
    const ref = thumbnailRef(row);
    const target = ref.prefix === "link" ? link : thumbs;
    let set = target.get(ref.slug);
    if (!set) { set = new Set<string>(); target.set(ref.slug, set); }
    set.add(ref.key);
  }
  return { thumbs, link };
}
