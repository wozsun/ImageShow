export function storageObjectKey(device: string, brightness: string, theme: string, id: string, ext: string) {

  return `${device}-${brightness}/${theme || "none"}/${id}.${ext}`;
}

export function thumbnailObjectKey(objectKey: string) {
  return `${objectKey.replace(/\.[^/.]+$/, "")}.webp`;
}

export function thumbnailRef(row: { object_key: string; storage_slug: string }): { prefix: "thumbs"; key: string; slug: string } {
  return { prefix: "thumbs", key: thumbnailObjectKey(row.object_key), slug: row.storage_slug };
}
