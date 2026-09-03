const imageUuidPattern =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const imageExtensionPattern = "(?:jpg|png|webp|gif|avif)";

export function storageObjectKey(id: string, ext: string) {
  return `${id.slice(-2)}/${id}.${ext}`;
}

const stableImageObjectKeyPattern = new RegExp(
  `^([0-9a-f]{2})/(${imageUuidPattern})\\.(${imageExtensionPattern})$`,
  "u"
);
const stableImageObjectKeyMaxLength = 44;

export function isStableImageObjectKey(key: string) {
  if (key.length > stableImageObjectKeyMaxLength) return false;
  const match = stableImageObjectKeyPattern.exec(key);
  return Boolean(match && match[1] === match[2]?.slice(-2));
}

// storage-layout-upgrade: remove this legacy classifier with /media in 5.6.1.
const legacyImageObjectKeyPattern = new RegExp(
  "^(?:pc|mb)-(?:dark|light)/"
    + "(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,30}[a-z0-9])/"
    + imageUuidPattern
    + "\\.(?:jpg|png|webp|gif|avif)$",
  "u"
);
const legacyImageObjectKeyMaxLength = 83;

export function isLegacyImageObjectKey(key: string) {
  return key.length <= legacyImageObjectKeyMaxLength
    && legacyImageObjectKeyPattern.test(key);
}

export function isCanonicalImageObjectKey(key: string) {
  return isStableImageObjectKey(key) || isLegacyImageObjectKey(key);
}

export type ImageObjectPrefix = "full" | "media";

export function imageObjectPrefix(key: string): ImageObjectPrefix {
  if (isStableImageObjectKey(key)) return "full";
  if (isLegacyImageObjectKey(key)) return "media";
  throw new TypeError("Invalid image object key");
}

export function isImageObjectKeyForPrefix(
  prefix: ImageObjectPrefix,
  key: string
) {
  return prefix === "full"
    ? isStableImageObjectKey(key)
    : isLegacyImageObjectKey(key);
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
