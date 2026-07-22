const stagingImageSuffix = ".image.webp";
const stagingThumbnailSuffix = ".thumb.webp";
const stagingObjectSuffixes = [stagingImageSuffix, stagingThumbnailSuffix] as const;
const uuidPrefixPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.|$)/i;

export function stagingImageKey(id: string, attempt?: string) {
  return `${id}${attempt ? `.${attempt}` : ""}${stagingImageSuffix}`;
}

export function stagingThumbnailKey(id: string, attempt?: string) {
  return `${id}${attempt ? `.${attempt}` : ""}${stagingThumbnailSuffix}`;
}

export function stagingSessionId(key: string) {
  const suffix = stagingObjectSuffixes.find((candidate) => (
    key.length > candidate.length && key.endsWith(candidate)
  ));
  if (!suffix) return "";
  const base = key.slice(0, -suffix.length);
  const match = uuidPrefixPattern.exec(base);
  return match ? match[0].replace(/\.$/, "") : "";
}
