export function storageObjectKey(device: string, brightness: string, theme: string, id: string, ext: string) {
  const filename = `${id}.${ext}`;
  if (device === "none" || brightness === "none") return `unset/${filename}`;
  return `${device}-${brightness}/${theme || "none"}/${filename}`;
}

export function thumbnailObjectKey(objectKey: string) {
  return `${objectKey.replace(/\.[^/.]+$/, "")}.webp`;
}
