const imageUuidPattern =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const imageExtensionPattern = "(?:jpg|png|webp|gif|avif)";
const imageUuidRegex = new RegExp(`^${imageUuidPattern}$`, "u");

const canonicalImageObjectKeyPattern = new RegExp(
  `^([0-9a-f]{2})/(${imageUuidPattern})\\.(${imageExtensionPattern})$`,
  "u"
);
const canonicalImageObjectKeyMaxLength = 44;

export function parseImageObjectKey(key: string) {
  if (key.length > canonicalImageObjectKeyMaxLength) return null;
  const match = canonicalImageObjectKeyPattern.exec(key);
  if (!match || match[1] !== match[2]?.slice(-2)) return null;
  return { id: match[2]!, ext: match[3]! };
}

export function isCanonicalImageObjectKey(key: string) {
  return parseImageObjectKey(key) !== null;
}

export function assertCanonicalImageObjectKey(key: string) {
  if (!isCanonicalImageObjectKey(key)) {
    throw new TypeError("Invalid image object key");
  }
}

export function thumbnailObjectKey(id: string) {
  if (!imageUuidRegex.test(id)) {
    throw new TypeError("Invalid image UUID");
  }
  return storageObjectKey(id, "webp");
}

export function thumbnailRef(row: { id: string; storage_slug: string }): { prefix: "thumbs"; key: string; slug: string } {
  return { prefix: "thumbs", key: thumbnailObjectKey(row.id), slug: row.storage_slug };
}
import { storageObjectKey } from "@imageshow/shared/browser";
