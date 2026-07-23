import { slugPattern } from "@imageshow/shared";
import { withAdvisoryLock } from "../core/db.ts";
import { ApiError } from "../core/api-error.ts";
import {
  invalidateImageCaches,
  type ImageLookupInvalidationEntry
} from "../images/image-cache.ts";
import { rebuildRandomPool } from "../random/cache-rebuild.ts";
import { syncRandomImages } from "../random/cache-sync.ts";
import {
  invalidateEntityCountCaches,
  refreshEntityVocabularies
} from "./vocab-cache.ts";

export type VocabularyEntity = "author" | "tag" | "theme";

const vocabularyLabels: Record<VocabularyEntity, string> = {
  author: "Author",
  tag: "Tag",
  theme: "Theme"
};

export function vocabularyMutationLockKey(
  entity: VocabularyEntity,
  slug: string
) {
  return `imageshow:${entity}:${slug}`;
}

export function vocabularyAssociationLockRequests(
  entries: readonly { entity: VocabularyEntity; slug: string }[]
) {
  return [...new Set(entries.map(({ entity, slug }) => (
    vocabularyMutationLockKey(entity, slug)
  )))]
    .sort()
    .map((key) => ({ key, mode: "shared" as const }));
}

export function withVocabularyAssociationLock<T>(
  entity: VocabularyEntity,
  slug: string,
  work: (signal: AbortSignal) => Promise<T>
) {
  return withAdvisoryLock(
    vocabularyMutationLockKey(entity, slug),
    work,
    "shared"
  );
}

export function withVocabularyMutationLock<T>(
  entity: VocabularyEntity,
  slug: string,
  work: (signal: AbortSignal) => Promise<T>
) {
  return withAdvisoryLock(vocabularyMutationLockKey(entity, slug), work);
}

export function assertVocabularySlug(
  entity: VocabularyEntity,
  slug: string,
  options: { reserved?: readonly string[] } = {}
) {
  if (
    options.reserved?.includes(slug)
    || slug.length > 32
    || !slugPattern.test(slug)
  ) {
    const label = vocabularyLabels[entity];
    throw new ApiError(
      400,
      `invalid_${entity}`,
      `${label} slug must be a lowercase slug (a-z, 0-9, -), <=32 chars`,
      { slug }
    );
  }
}

export function assertVocabularyCreated(
  entity: VocabularyEntity,
  slug: string,
  rowCount: number | null
) {
  if (rowCount) return;
  const messages: Record<VocabularyEntity, string> = {
    author: "作者已存在",
    tag: "标签已存在",
    theme: "主题已存在"
  };
  throw new ApiError(409, `${entity}_exists`, messages[entity], { slug });
}

export function assertVocabularyFound(
  entity: VocabularyEntity,
  rowCount: number | null
) {
  if (rowCount) return;
  throw new ApiError(
    404,
    "not_found",
    `${vocabularyLabels[entity]} not found`
  );
}

type VocabularyMutationSync = {
  entity: VocabularyEntity;
  lookupEntries?: readonly ImageLookupInvalidationEntry[];
  imageDataChanged?: boolean;
  random?:
    | { mode: "rebuild" }
    | { mode: "images"; ids: readonly string[] };
  facets?: boolean;
};

/**
 * 派生状态修复顺序固定为随机池、词表缓存、图片代际。图片代际最后推进，
 * 可避免新代际的 gallery facets 在词表刷新前重新物化旧标签。每一阶段即使
 * 失败也会继续执行后续阶段，最终再抛出首个错误。
 */
export async function synchronizeVocabularyMutation({
  entity,
  lookupEntries = [],
  imageDataChanged = false,
  random,
  facets = true
}: VocabularyMutationSync) {
  const failures: unknown[] = [];

  if (random?.mode === "rebuild") {
    await rebuildRandomPool().catch((error) => failures.push(error));
  } else if (random?.mode === "images" && random.ids.length) {
    await syncRandomImages([...random.ids]).catch((error) => failures.push(error));
  }

  const vocabularyRepairs = await Promise.allSettled([
    refreshEntityVocabularies([entity]),
    invalidateEntityCountCaches([entity])
  ]);
  for (const repair of vocabularyRepairs) {
    if (repair.status === "rejected") failures.push(repair.reason);
  }

  if (imageDataChanged || facets) {
    await invalidateImageCaches({ lookupEntries, facets })
      .catch((error) => failures.push(error));
  }

  if (failures.length) throw failures[0];
}
