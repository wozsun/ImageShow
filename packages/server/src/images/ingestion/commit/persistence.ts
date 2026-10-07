import { imageVariants, imageDevice } from "@imageshow/shared/browser";
import { bumpReadyImageRevision } from "../../ready-cache/revision.ts";
import { ApiError } from "../../../core/api-error.ts";
import { withTransaction } from "../../../core/database/transactions.ts";
import { ensureAuthorWithMutationLockHeld } from "../../../vocab/authors/mutations.ts";
import { replaceImageTagAssociations } from "../../../vocab/tags/mutations.ts";
import { ensureThemeWithMutationLockHeld } from "../../../vocab/themes/mutations.ts";
import type { EntityCacheKind } from "../../../vocab/cache.ts";
import { resolveClassification } from "../../classification.ts";
import {
  adminImageListPresentationColumns,
  adminImageListPresentationColumnsWithTags,
  type ImageRecord,
  type ImageRecordWithTags
} from "../../presenter.ts";
import type { IngestionSessionSnapshot } from "../sessions/model.ts";

export async function persistIngestionImage(
  session: IngestionSessionSnapshot,
  resolvedTags: string[]
) {
  const prepared = session.prepared!;
  const commit = session.commit!;
  return withTransaction(async (client) => {
    const existing = (
      await client.query<ImageRecordWithTags & { created_by: string }>(
        `SELECT ${adminImageListPresentationColumnsWithTags}, created_by
         FROM metadata
        WHERE id=$1`,
        [session.image_id]
      )
    ).rows[0];
    if (existing) {
      if (existing.created_by !== commit.created_by) {
        throw new ApiError(
          409,
          "ingestion_image_owner_conflict",
          "图片 ID 已属于其他管理员"
        );
      }
      return {
        inserted: false,
        image: existing,
        createdEntityKinds: new Set<EntityCacheKind>()
      };
    }

    const createdEntityKinds = new Set<EntityCacheKind>();
    if (
      commit.metadata.theme !== null &&
      (await ensureThemeWithMutationLockHeld(client, commit.metadata.theme))
    ) {
      createdEntityKinds.add("theme");
    }
    if (
      commit.metadata.author !== null &&
      (await ensureAuthorWithMutationLockHeld(client, commit.metadata.author))
    ) {
      createdEntityKinds.add("author");
    }
    const classification = resolveClassification(commit.metadata, {
      device: imageDevice(prepared.variants.large.width, prepared.variants.large.height),
      brightness: prepared.detected_brightness
    });
    const inserted = await client.query<ImageRecord>(
      `INSERT INTO metadata(
         id, image_time, device, brightness, theme, storage_slug, title, description, source, original, author, created_by,
         l_width, l_height, l_byte_size, l_md5, m_width, m_height, m_byte_size, m_md5, s_width, s_height, s_byte_size, s_md5
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING ${adminImageListPresentationColumns}, false AS purge_pending`,
      [
        session.image_id,
        session.image_time,
        classification.device,
        classification.brightness,
        commit.metadata.theme,
        session.storage_slug,
        commit.metadata.title,
        commit.metadata.description,
        commit.metadata.source,
        commit.metadata.original,
        commit.metadata.author,
        commit.created_by,
        ...imageVariants.flatMap((variant) => {
          const facts = prepared.variants[variant];
          return [facts.width, facts.height, facts.bytes, facts.md5];
        })
      ]
    );
    if (
      (await replaceImageTagAssociations(
        client,
        session.image_id,
        resolvedTags
      ))
        .createdTag
    ) {
      createdEntityKinds.add("tag");
    }
    await bumpReadyImageRevision(client);
    return {
      inserted: true,
      image: {
        ...inserted.rows[0]!,
        tags: resolvedTags
      },
      createdEntityKinds
    };
  });
}
