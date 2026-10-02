import { storageObjectKey } from "@imageshow/shared/browser";

const imageUuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const imageUuidRegex = new RegExp(`^${imageUuidPattern}$`, "u");

const canonicalImageObjectKeyPattern = new RegExp(
  `^([0-9a-f]{2})/(${imageUuidPattern})\\.webp$`,
  "u"
);

export function parseImageObjectKey(key: string) {
  const match = canonicalImageObjectKeyPattern.exec(key);
  if (!match || match[1] !== match[2]?.slice(-2)) return null;
  return { id: match[2]! };
}

export function imageObjectKey(id: string) {
  if (!imageUuidRegex.test(id)) {
    throw new TypeError("Invalid image UUID");
  }
  return storageObjectKey(id);
}
