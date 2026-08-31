import type { Pool, PoolClient } from "pg";
import type { AuthorDto } from "@imageshow/shared/browser";
import { pool } from "../core/database/pools.ts";
import { withTransaction } from "../core/database/transactions.ts";
import { ApiError } from "../core/api-error.ts";
import {
  assertVocabularyCreated,
  assertVocabularyFound,
  assertVocabularySlug,
  synchronizeVocabularyMutation,
  withVocabularyMutationLock
} from "../vocab/mutation-sync.ts";
import {
  withImageMutationSync,
  type ImageMutationSyncBatch
} from "../images/mutation-sync.ts";
import { bumpReadyImageRevision } from "../images/ready-cache/revision.ts";
import {
  invalidateEntityCountCaches,
  refreshEntityVocabularies
} from "../vocab/vocab-cache.ts";
import {
  deriveAuthorIdentityFromLink,
  projectAuthorDerivedIdentity,
  type AuthorIdentityColumns
} from "./identity.ts";

type AuthorMutationRow = AuthorIdentityColumns & {
  slug: string;
  display_name: string;
  link: string;
};

function authorMutationDto(
  row: AuthorMutationRow,
  imageCount: number
): AuthorDto {
  return {
    slug: row.slug,
    display_name: row.display_name,
    link: row.link,
    image_count: imageCount,
    derived_identity: projectAuthorDerivedIdentity(row)
  };
}

function authorIdentityConflict(error: unknown): never {
  if ((error as { code?: string }).code === "23505") {
    throw new ApiError(
      409,
      "author_identity_exists",
      "该作者主页身份已绑定到其他作者"
    );
  }
  throw error;
}

/** Use only while the caller owns a shared association or exclusive mutation lock. */
export async function ensureAuthorWithMutationLockHeld(
  client: Pool | PoolClient,
  slug: string
) {
  if (!slug) return false;
  const result = await client.query(
    `INSERT INTO author(slug, sort_order)
     VALUES($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM author))
     ON CONFLICT (slug) DO NOTHING
     RETURNING slug`,
    [slug]
  );
  return Boolean(result.rowCount);
}

export async function createAuthor(
  slug: string,
  displayName: string,
  link: string
): Promise<AuthorDto> {
  assertVocabularySlug("author", slug);
  const identity = deriveAuthorIdentityFromLink(link);

  let created: AuthorMutationRow | null;
  try {
    created = await withVocabularyMutationLock(
      "author",
      slug,
      (signal) => withTransaction(async (client) => {
        signal.throwIfAborted();
        const result = await client.query<AuthorMutationRow>(
          `INSERT INTO author(
             slug,
             display_name,
             link,
             identity_provider,
             identity_id,
             sort_order
           )
           VALUES(
             $1,
             $2,
             $3,
             $4,
             $5,
             (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM author)
           )
           ON CONFLICT (slug) DO NOTHING
           RETURNING slug,
                     display_name,
                     link,
                     identity_provider,
                     identity_id`,
          [slug, displayName, link, identity?.provider ?? null, identity?.id ?? null]
        );
        signal.throwIfAborted();
        return result.rows[0] ?? null;
      })
    );
  } catch (error) {
    authorIdentityConflict(error);
  }
  assertVocabularyCreated("author", slug, created ? 1 : 0);
  await synchronizeVocabularyMutation({ entity: "author" });
  return authorMutationDto(created!, 0);
}

export async function updateAuthorProfile(
  slug: string,
  displayName: string,
  link: string
): Promise<AuthorDto> {
  const identity = deriveAuthorIdentityFromLink(link);
  let updated: AuthorDto | null;
  try {
    updated = await withVocabularyMutationLock(
      "author",
      slug,
      (signal) => withTransaction(async (client) => {
        signal.throwIfAborted();
        const result = await client.query<AuthorMutationRow>(
          `UPDATE author
              SET display_name=$2,
                  link=$3,
                  identity_provider=$4,
                  identity_id=$5,
                  updated_at=now()
            WHERE slug=$1
            RETURNING slug,
                      display_name,
                      link,
                      identity_provider,
                      identity_id`,
          [slug, displayName, link, identity?.provider ?? null, identity?.id ?? null]
        );
        signal.throwIfAborted();
        const row = result.rows[0];
        if (!row) return null;
        const imageCount = Number((await client.query<{ image_count: number }>(
          `SELECT count(*)::int AS image_count
             FROM metadata
            WHERE author=$1
              AND status='ready'`,
          [slug]
        )).rows[0]?.image_count ?? 0);
        signal.throwIfAborted();
        return authorMutationDto(row, imageCount);
      })
    );
  } catch (error) {
    authorIdentityConflict(error);
  }
  assertVocabularyFound("author", updated ? 1 : 0);
  await synchronizeVocabularyMutation({ entity: "author" });
  return updated!;
}

export async function reorderAuthors(slugs: string[]) {
  if (!slugs.length) return;
  await pool.query(
    `UPDATE author a SET sort_order = v.ord, updated_at = now()
     FROM unnest($1::text[]) WITH ORDINALITY AS v(slug, ord)
     WHERE a.slug = v.slug`,
    [slugs]
  );
  await synchronizeVocabularyMutation({ entity: "author" });
}

type ClearedAuthorImage = { id: string };

async function deleteAuthorUnderLock(
  slug: string,
  signal: AbortSignal,
  mutationBatch: ImageMutationSyncBatch
) {
  return withTransaction(async (client) => {
    signal.throwIfAborted();
    const author = await client.query(
      "SELECT slug FROM author WHERE slug=$1 FOR UPDATE",
      [slug]
    );
    signal.throwIfAborted();
    if (!author.rowCount) {
      return { deleted: false, affected: [] as ClearedAuthorImage[] };
    }
    const affectedCount = Number((await client.query(
      `SELECT count(*)::int AS count
         FROM metadata
        WHERE author=$1
          AND status='ready'`,
      [slug]
    )).rows[0]?.count ?? 0);
    signal.throwIfAborted();
    const decision = mutationBatch.decide(affectedCount);
    const affected = decision.mode === "exact"
      ? (await client.query(
        `SELECT id
           FROM metadata
          WHERE author=$1
            AND status='ready'
          ORDER BY id`,
        [slug]
      )).rows as ClearedAuthorImage[]
      : [];
    signal.throwIfAborted();
    await client.query(
      `UPDATE metadata
          SET author=NULL, updated_at=now()
        WHERE author=$1`,
      [slug]
    );
    signal.throwIfAborted();
    const deleted = Boolean((await client.query(
      "DELETE FROM author WHERE slug=$1",
      [slug]
    )).rowCount);
    signal.throwIfAborted();
    if (affectedCount) await bumpReadyImageRevision(client);
    return { deleted, affected };
  });
}

export async function deleteAuthor(slug: string) {
  const result = await withVocabularyMutationLock(
    "author",
    slug,
    (signal) => withImageMutationSync(async (mutationBatch) => {
      const deleted = await deleteAuthorUnderLock(
        slug,
        signal,
        mutationBatch
      );
      for (const image of deleted.affected) {
        mutationBatch.add({ id: image.id });
      }
      await Promise.all([
        refreshEntityVocabularies(["author"]),
        invalidateEntityCountCaches(["author"])
      ]);
      return deleted;
    })
  );
  assertVocabularyFound("author", result.deleted ? 1 : 0);
}
