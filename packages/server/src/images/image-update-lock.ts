function imageUpdateLockKey(imageId: string) {
  return `imageshow:image-update:${imageId}`;
}

export function imageUpdateLockRequests(imageIds: string[]) {
  return [...new Set(
    imageIds.map((imageId) => imageUpdateLockKey(imageId.toLowerCase()))
  )]
    .sort()
    .map((key) => ({ key }));
}
