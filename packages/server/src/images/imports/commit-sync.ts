import { ApiError } from "../../core/api-error.ts";
import { syncRandomImage } from "../../random/cache-sync.ts";
import {
  invalidateEntityCountCaches,
  refreshEntityVocabularies,
  type EntityCacheKind
} from "../../vocab/vocab-cache.ts";
import {
  invalidateImageCaches,
  warmCompleteImageLookups
} from "../image-cache.ts";
import { readCommittedImage } from "./commit-persistence.ts";
import type { PreparedPayload } from "./types.ts";

export async function synchronizeCommittedImport(
  imageId: string,
  payload: PreparedPayload,
  createdEntityKinds: Iterable<EntityCacheKind> = []
) {
  const image = await readCommittedImage(imageId);
  if (!image) {
    throw new ApiError(
      409,
      "committed_image_missing",
      "导入已提交，但图片记录不存在"
    );
  }

  await syncRandomImage(image.id);
  const [cacheRevision] = await Promise.all([
    invalidateImageCaches({
      lookupEntries: [{ id: image.id, object_key: image.object_key }],
      md5s: [payload.md5]
    }),
    invalidateEntityCountCaches([
      "theme",
      ...(image.author ? ["author" as const] : []),
      ...((payload.tags?.length ?? 0) ? ["tag" as const] : [])
    ]),
    refreshEntityVocabularies(createdEntityKinds)
  ]);
  await warmCompleteImageLookups([{
    ...image,
    original: image.original ?? null,
    description: image.description ?? null,
    source: image.source ?? null
  }], cacheRevision);
  return image;
}
