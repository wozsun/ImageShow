const imageUuidPattern =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const imageExtensionPattern = "(?:jpg|png|webp|gif|avif)";

export function storageObjectKey(id: string, ext: string) {
  return `${id.slice(-2)}/${id}.${ext}`;
}

const canonicalImageObjectKeyPattern = new RegExp(
  `^([0-9a-f]{2})/(${imageUuidPattern})\\.(${imageExtensionPattern})$`,
  "u"
);
const canonicalImageObjectKeyMaxLength = 44;

export function isCanonicalImageObjectKey(key: string) {
  if (key.length > canonicalImageObjectKeyMaxLength) return false;
  const match = canonicalImageObjectKeyPattern.exec(key);
  return Boolean(match && match[1] === match[2]?.slice(-2));
}

export function assertCanonicalImageObjectKey(key: string) {
  if (!isCanonicalImageObjectKey(key)) {
    throw new TypeError("Invalid image object key");
  }
}

export function isCanonicalThumbnailObjectKey(key: string) {
  return key.endsWith(".webp") && isCanonicalImageObjectKey(key);
}

export function thumbnailObjectKey(objectKey: string) {
  assertCanonicalImageObjectKey(objectKey);
  return `${objectKey.replace(/\.[^/.]+$/, "")}.webp`;
}

export function thumbnailRef(row: { object_key: string; storage_slug: string }): { prefix: "thumbs"; key: string; slug: string } {
  return { prefix: "thumbs", key: thumbnailObjectKey(row.object_key), slug: row.storage_slug };
}
