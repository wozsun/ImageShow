function batchImageUpdateLockKey(imageId: string) {
  return `imageshow:batch-image-update:${imageId}`;
}

export function batchImageUpdateLockRequests(imageIds: string[]) {
  return [...new Set(
    imageIds.map((imageId) => batchImageUpdateLockKey(imageId.toLowerCase()))
  )]
    .sort()
    .map((key) => ({ key }));
}
