export function storageObjectKey(device: string, brightness: string, theme: string, id: string, ext: string) {
  return `${device}-${brightness}/${theme || "none"}/${id}.${ext}`;
}

const canonicalImageObjectKeyPattern = new RegExp(
  "^(?:pc|mb)-(?:dark|light)/"
    + "(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,30}[a-z0-9])/"
    + "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    + "\\.(?:jpg|png|webp|gif|avif)$",
  "u"
);
const canonicalImageObjectKeyMaxLength = 83;

export function isCanonicalImageObjectKey(key: string) {
  return key.length <= canonicalImageObjectKeyMaxLength
    && canonicalImageObjectKeyPattern.test(key);
}

export function isCanonicalThumbnailObjectKey(key: string) {
  return key.endsWith(".webp") && isCanonicalImageObjectKey(key);
}

export function thumbnailObjectKey(objectKey: string) {
  return `${objectKey.replace(/\.[^/.]+$/, "")}.webp`;
}

export function thumbnailRef(row: { object_key: string; storage_slug: string }): { prefix: "thumbs"; key: string; slug: string } {
  return { prefix: "thumbs", key: thumbnailObjectKey(row.object_key), slug: row.storage_slug };
}
