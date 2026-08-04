import { ApiError } from "../../core/api-error.ts";
import {
  invalidateEntityCountCaches,
  refreshEntityVocabularies,
  type EntityCacheKind
} from "../../vocab/vocab-cache.ts";
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

  await Promise.all([
    invalidateEntityCountCaches([
      "theme",
      ...(image.author ? ["author" as const] : []),
      ...((payload.tags?.length ?? 0) ? ["tag" as const] : [])
    ]),
    refreshEntityVocabularies(createdEntityKinds)
  ]);
  return image;
}
