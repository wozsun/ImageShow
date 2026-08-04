import { withTransaction } from "../core/db.ts";
import { bumpReadyImageRevision } from "./ready-cache/revision.ts";

type RestoredImage = { id: string };

export type RestoreResult =
  | { status: "restored"; image: RestoredImage }
  | { status: "not_deleted" };

export async function restoreImageFromTrash(id: string): Promise<RestoreResult> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE metadata
          SET status='ready', deleted_at=NULL, updated_at=now()
        WHERE id=$1 AND status='deleted' AND purge_state='idle'
        RETURNING id`,
      [id]
    );
    const image = result.rows[0] as RestoredImage | undefined;
    if (!image) return { status: "not_deleted" };
    await bumpReadyImageRevision(client);
    return { status: "restored", image };
  });
}

export async function restoreImagesFromTrash(ids: string[]): Promise<RestoredImage[]> {
  if (!ids.length) return [];
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE metadata
          SET status='ready', deleted_at=NULL, updated_at=now()
        WHERE id = ANY($1::uuid[]) AND status='deleted' AND purge_state='idle'
        RETURNING id`,
      [ids]
    );
    const images = result.rows as RestoredImage[];
    if (images.length) await bumpReadyImageRevision(client);
    return images;
  });
}
