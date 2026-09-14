import { pool } from "../core/database/pools.ts";
import { assertVocabularyFound, assertVocabularySlug, synchronizeVocabularyMutation } from "./mutation-sync.ts";
import type { EntityCacheKind } from "./vocab-cache.ts";

export async function setVocabularySortOrder(entity: EntityCacheKind, slug: string, sortOrder: number) {
  assertVocabularySlug(entity, slug);
  try {
    const result = await pool.query(
      `UPDATE ${entity} SET sort_order=$2, updated_at=now() WHERE slug=$1`,
      [slug, sortOrder]
    );
    assertVocabularyFound(entity, result.rowCount);
  } finally {
    // A lost write acknowledgement must not leave derived lists authoritative.
    await synchronizeVocabularyMutation({ entity });
  }
}
