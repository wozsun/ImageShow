import type { PoolClient } from "pg";
import type { ImageMutationSyncBatch } from "../images/mutation-sync.ts";
import type { VocabularyEntity } from "./mutation-sync.ts";

export async function readVocabularyMutationImpact(
  client: PoolClient,
  entity: VocabularyEntity,
  slug: string,
  batch: ImageMutationSyncBatch,
  signal: AbortSignal
) {
  const relation = entity === "tag"
    ? "metadata m JOIN image_tag it ON it.image_id=m.id"
    : "metadata m";
  const predicate = entity === "tag" ? "it.tag_slug=$1" : `m.${entity}=$1`;
  const from = `FROM ${relation} WHERE ${predicate} AND m.status='ready'`;
  const affectedCount = Number((
    await client.query(
      `SELECT count(*)::int AS count ${from}`,
      [slug]
    )
  ).rows[0]?.count ?? 0);
  signal.throwIfAborted();
  const decision = batch.decide(affectedCount);
  const affected = decision.mode === "exact"
    ? (await client.query<{ id: string }>(
        `SELECT m.id ${from} ORDER BY m.id`,
        [slug]
      )).rows
    : [];
  signal.throwIfAborted();
  return { affectedCount, affected };
}
