export function storageObjectKey(device: string, brightness: string, theme: string, id: string, ext: string) {
  // device and brightness are always concrete (pc/mb, dark/light), so every object has a
  // structured key — there is no "unset" bucket.
  return `${device}-${brightness}/${theme || "none"}/${id}.${ext}`;
}

export function thumbnailObjectKey(objectKey: string) {
  return `${objectKey.replace(/\.[^/.]+$/, "")}.webp`;
}

// Link images have no stored original (their object key is an external URL), so the
// thumbnail can't be derived from it. It lives under the top-level "link" prefix in the
// backend the import chose, foldered by category exactly like stored objects
// (<device>-<brightness>/<theme>/) and named by the image id. The id keeps the name
// stable across rename edits; a category edit relocates the file to the new folder (see
// updateImageMetadata). This returns the key within the "link" prefix.
export function linkThumbnailKey(device: string, brightness: string, theme: string, id: string) {
  return `${device}-${brightness}/${theme || "none"}/${id}.webp`;
}

// Single source of truth for where an image's thumbnail lives — used by the write
// path and every cleanup path, so a thumbnail is never orphaned. The thumbnail always
// lives in the image's storage_slug backend; only the key layout differs: link
// thumbnails sit under the "link" prefix (id-named, foldered by category since the
// object key is a URL), everything else sits beside its object under "thumbs".
export function thumbnailRef(row: { id: string; object_key: string; storage_slug: string; is_link: boolean; device: string; brightness: string; theme: string }): { prefix: "thumbs" | "link"; key: string; slug: string } {
  if (row.is_link) return { prefix: "link", key: linkThumbnailKey(row.device, row.brightness, row.theme, row.id), slug: row.storage_slug };
  return { prefix: "thumbs", key: thumbnailObjectKey(row.object_key), slug: row.storage_slug };
}
