export function storageObjectKey(device: string, brightness: string, theme: string, id: string, ext: string) {

  return `${device}-${brightness}/${theme || "none"}/${id}.${ext}`;
}

export function thumbnailObjectKey(objectKey: string) {
  return `${objectKey.replace(/\.[^/.]+$/, "")}.webp`;
}

export function linkThumbnailKey(device: string, brightness: string, theme: string, id: string) {
  return `${device}-${brightness}/${theme || "none"}/${id}.webp`;
}

export function thumbnailRef(row: { id: string; object_key: string; storage_slug: string; is_link: boolean; device: string; brightness: string; theme: string }): { prefix: "thumbs" | "link"; key: string; slug: string } {
  if (row.is_link) return { prefix: "link", key: linkThumbnailKey(row.device, row.brightness, row.theme, row.id), slug: row.storage_slug };
  return { prefix: "thumbs", key: thumbnailObjectKey(row.object_key), slug: row.storage_slug };
}
