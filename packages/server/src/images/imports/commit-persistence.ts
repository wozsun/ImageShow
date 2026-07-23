import { ensureAuthorWithMutationLockHeld } from "../../authors/mutations.ts";
import type { PoolClient } from "pg";
import { ApiError } from "../../core/api-error.ts";
import { pool, withTransaction } from "../../core/db.ts";
import { replaceImageTags } from "../../tags/mutations.ts";
import { ensureThemeWithMutationLockHeld } from "../../themes/mutations.ts";
import type { EntityCacheKind } from "../../vocab/vocab-cache.ts";
import { resolveClassification } from "../classification.ts";
import type { ImageRecord } from "../presenter.ts";
import type {
  ImportSessionRow,
  PreparedPayload
} from "./types.ts";

type CommittedImageRecord = Pick<
  ImageRecord,
  | "id"
  | "author"
  | "object_key"
  | "original"
  | "ext"
  | "storage_slug"
  | "device"
  | "brightness"
  | "theme"
  | "status"
  | "description"
  | "source"
>;

type CommitPersistenceSession = Pick<
  ImportSessionRow,
  "storage_slug" | "final_object_key" | "image_time"
>;

const committedImageColumns = [
  "id",
  "author",
  "object_key",
  "original",
  "ext",
  "storage_slug",
  "device",
  "brightness",
  "theme",
  "status",
  "description",
  "source"
].join(", ");

export async function readCommittedImage(id: string) {
  return (await pool.query(
    `SELECT ${committedImageColumns} FROM metadata WHERE id=$1`,
    [id]
  )).rows[0] as CommittedImageRecord | undefined;
}

export function persistCommittedImage(
  id: string,
  session: CommitPersistenceSession,
  payload: PreparedPayload,
  executionToken: string,
  resolvedTags: string[],
  signal: AbortSignal
) {
  return withTransaction(async (client) => {
    signal.throwIfAborted();
    const createdEntityKinds = new Set<EntityCacheKind>();
    if (await ensureThemeWithMutationLockHeld(client, payload.theme)) {
      createdEntityKinds.add("theme");
    }
    if (await ensureAuthorWithMutationLockHeld(client, payload.author)) {
      createdEntityKinds.add("author");
    }
    signal.throwIfAborted();

    const classification = resolveClassification(payload, {
      device: payload.detected_device,
      brightness: payload.detected_brightness
    });
    const insertedRow = await client.query(
      `INSERT INTO metadata(
         id, image_time, device, brightness, theme, width, height, image_size,
         ext, object_key, storage_slug, title, description, source, original,
         md5, thumbnail_size, author
       )
       VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING ${committedImageColumns}`,
      [
        id,
        session.image_time,
        classification.device,
        classification.brightness,
        payload.theme,
        payload.width,
        payload.height,
        payload.size,
        payload.ext,
        session.final_object_key,
        session.storage_slug,
        payload.title,
        payload.description,
        payload.source,
        payload.original,
        payload.md5,
        payload.thumbnail_size,
        payload.author || null
      ]
    );
    const image = (insertedRow.rowCount
      ? insertedRow.rows[0]
      : await readCommittedImageWithClient(client, id)
    ) as CommittedImageRecord;
    if ((await replaceImageTags(
      client,
      image.id,
      resolvedTags,
      signal
    )).createdTag) {
      createdEntityKinds.add("tag");
    }
    signal.throwIfAborted();

    const finalized = await client.query(
      `UPDATE import_session
          SET status='finalized', execution_token=NULL, updated_at=now()
        WHERE id=$1 AND status='committing' AND execution_token=$2::uuid`,
      [id, executionToken]
    );
    if (!finalized.rowCount) {
      throw new ApiError(
        409,
        "invalid_import_state",
        "导入任务提交状态已变化"
      );
    }
    return { image, createdEntityKinds };
  });
}

async function readCommittedImageWithClient(
  client: PoolClient,
  id: string
) {
  return (await client.query(
    `SELECT ${committedImageColumns} FROM metadata WHERE id=$1`,
    [id]
  )).rows[0] as CommittedImageRecord | undefined;
}
