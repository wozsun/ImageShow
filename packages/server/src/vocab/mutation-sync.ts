import { slugMaxLength, slugPattern } from "@imageshow/shared/browser";
import {
  withAdvisoryLock
} from "../core/database/advisory-locks.ts";
import { ApiError } from "../core/api-error.ts";
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
    || slug.length > slugMaxLength
    || !slugPattern.test(slug)
  ) {
    const label = vocabularyLabels[entity];
    throw new ApiError(
      400,
      `invalid_${entity}`,
      `${label} slug must be a lowercase slug (a-z, 0-9, -), <=${slugMaxLength} chars`,
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

export async function synchronizeVocabularyMutation({
  entity
}: {
  entity: VocabularyEntity;
}) {
  await Promise.all([
    refreshEntityVocabularies([entity]),
    invalidateEntityCountCaches([entity])
  ]);
}
