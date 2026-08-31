import type {
  LegacyWeiboAuthorSlugs
} from "../config/legacy-weibo-author-slugs-config.ts";
import {
  finalizeLegacyWeiboAuthorSlugsUpgrade,
  getPendingLegacyWeiboAuthorSlugsUpgrade
} from "../config/runtime-config-store.ts";
import { withTransaction } from "../core/database/transactions.ts";
import {
  canonicalWeiboAuthorHomepage,
  deriveAuthorIdentityFromLink
} from "./identity.ts";

type UpgradeAuthorRow = {
  slug: string;
  link: string;
  identity_provider: string | null;
  identity_id: string | null;
};

type AuthorUpgrade = {
  slug: string;
  link: string;
  userId: string;
};

function legacyUpgradeError(reason: string) {
  return new Error(`Cannot migrate legacy weibo.author_slugs: ${reason}`);
}

export async function migrateAuthorIdentitiesForLegacyWeiboConfig(
  mapping: LegacyWeiboAuthorSlugs = {}
) {
  const entries = Object.entries(mapping).sort(([left], [right]) => (
    left.localeCompare(right)
  ));
  const slugs = entries.map(([, slug]) => slug);
  if (new Set(slugs).size !== slugs.length) {
    throw legacyUpgradeError("one author is referenced by multiple identities");
  }

  try {
    return await withTransaction(async (client) => {
      await client.query("LOCK TABLE author IN SHARE ROW EXCLUSIVE MODE");
      const authors = (await client.query<UpgradeAuthorRow>(
        `SELECT slug, link, identity_provider, identity_id
           FROM author
          ORDER BY slug
          FOR UPDATE`
      )).rows;
      const authorsBySlug = new Map(authors.map((author) => [author.slug, author]));
      if (slugs.some((slug) => !authorsBySlug.has(slug))) {
        throw legacyUpgradeError("a referenced author does not exist");
      }

      const upgrades = new Map<string, AuthorUpgrade>();
      for (const author of authors) {
        const linkedIdentity = deriveAuthorIdentityFromLink(author.link);
        if (!linkedIdentity) continue;
        upgrades.set(author.slug, {
          slug: author.slug,
          link: author.link,
          userId: linkedIdentity.id
        });
      }

      for (const [userId, slug] of entries) {
        const author = authorsBySlug.get(slug)!;
        if (author.link) {
          const linkedIdentity = deriveAuthorIdentityFromLink(author.link);
          if (
            linkedIdentity?.provider !== "weibo"
            || linkedIdentity.id !== userId
          ) {
            throw legacyUpgradeError("a referenced author has a conflicting link");
          }
        }
        upgrades.set(slug, {
          slug,
          link: author.link || canonicalWeiboAuthorHomepage(userId),
          userId
        });
      }

      const identityOwners = new Map<string, string>();
      for (const author of authors) {
        if (author.identity_provider !== null || author.identity_id !== null) {
          if (
            author.identity_provider !== "weibo"
            || author.identity_id === null
          ) {
            throw legacyUpgradeError("an author has an unsupported identity");
          }
          const linkedIdentity = deriveAuthorIdentityFromLink(author.link);
          if (
            linkedIdentity?.provider !== "weibo"
            || linkedIdentity.id !== author.identity_id
          ) {
            throw legacyUpgradeError("an author identity conflicts with its link");
          }
          const existingOwner = identityOwners.get(author.identity_id);
          if (existingOwner !== undefined && existingOwner !== author.slug) {
            throw legacyUpgradeError("an identity is already owned by another author");
          }
          identityOwners.set(author.identity_id, author.slug);
        }
      }
      for (const upgrade of upgrades.values()) {
        const author = authorsBySlug.get(upgrade.slug)!;
        if (
          (author.identity_provider !== null || author.identity_id !== null)
          && (
            author.identity_provider !== "weibo"
            || author.identity_id !== upgrade.userId
          )
        ) {
          throw legacyUpgradeError("a referenced author has a conflicting identity");
        }
        const currentOwner = identityOwners.get(upgrade.userId);
        if (currentOwner !== undefined && currentOwner !== upgrade.slug) {
          throw legacyUpgradeError("an identity is already owned by another author");
        }
        identityOwners.set(upgrade.userId, upgrade.slug);
      }

      let updated = 0;
      for (const upgrade of upgrades.values()) {
        const result = await client.query(
          `UPDATE author
              SET link=$2,
                  identity_provider='weibo',
                  identity_id=$3,
                  updated_at=now()
            WHERE slug=$1
              AND (
                link IS DISTINCT FROM $2
                OR identity_provider IS DISTINCT FROM 'weibo'
                OR identity_id IS DISTINCT FROM $3
              )`,
          [upgrade.slug, upgrade.link, upgrade.userId]
        );
        updated += result.rowCount ?? 0;
      }
      return updated;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw legacyUpgradeError("an identity uniqueness conflict was detected");
    }
    throw error;
  }
}

export async function upgradeAuthorIdentitiesForLegacyWeiboConfigAtStartup() {
  const mapping = getPendingLegacyWeiboAuthorSlugsUpgrade();
  const updated = await migrateAuthorIdentitiesForLegacyWeiboConfig(
    mapping ?? {}
  );
  const finalizedLegacyConfig = mapping === undefined
    ? false
    : finalizeLegacyWeiboAuthorSlugsUpgrade();
  return { updated, finalizedLegacyConfig };
}
