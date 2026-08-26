import { ApiError } from "../../../core/api-error.ts";
import { withTransaction } from "../../../core/database/transactions.ts";
import { ensureAuthorWithMutationLockHeld } from "../../../authors/mutations.ts";
import { replaceImageTags } from "../../../tags/mutations.ts";
import { ensureThemeWithMutationLockHeld } from "../../../themes/mutations.ts";
import type { EntityCacheKind } from "../../../vocab/vocab-cache.ts";
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
    const existing = (await client.query<
      ImageRecordWithTags & { created_by: string }
    >(
      `SELECT ${adminImageListPresentationColumnsWithTags}, created_by
         FROM metadata
        WHERE id=$1`,
      [session.image_id]
    )).rows[0];
    if (existing) {
      if (existing.created_by !== commit.created_by) {
        throw new ApiError(
          409,
          "import_image_owner_conflict",
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
    if (await ensureThemeWithMutationLockHeld(client, commit.metadata.theme)) {
      createdEntityKinds.add("theme");
    }
    if (await ensureAuthorWithMutationLockHeld(client, commit.metadata.author)) {
      createdEntityKinds.add("author");
    }
    const classification = resolveClassification(commit.metadata, {
      device: prepared.detected_device,
      brightness: prepared.detected_brightness
    });
    const inserted = await client.query<ImageRecord>(
      `INSERT INTO metadata(
         id, image_time, device, brightness, theme, width, height, image_size,
         ext, object_key, storage_slug, title, description, source, original,
         md5, thumbnail_size, author, created_by
       )
       VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
       )
       RETURNING ${adminImageListPresentationColumns}`,
      [
        session.image_id,
        session.image_time,
        classification.device,
        classification.brightness,
        commit.metadata.theme,
        prepared.width,
        prepared.height,
        prepared.size,
        prepared.ext,
        commit.final_object_key,
        session.storage_slug,
        commit.metadata.title,
        commit.metadata.description,
        commit.metadata.source,
        commit.metadata.original,
        prepared.md5,
        prepared.thumbnail_size,
        commit.metadata.author || null,
        commit.created_by
      ]
    );
    if ((await replaceImageTags(
      client,
      session.image_id,
      resolvedTags,
      new AbortController().signal
    )).createdTag) {
      createdEntityKinds.add("tag");
    }
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
