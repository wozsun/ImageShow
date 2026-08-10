import { withTransaction } from "../core/database-transactions.ts";
import { bumpReadyImageRevision } from "./ready-cache/revision.ts";

type RestoredImage = { id: string };

export type RestoreImagesResult = {
  restored: number;
  images: RestoredImage[];
};

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

export async function restoreImagesFromTrash(
  ids: string[],
  options: { returnIds?: boolean } = {}
): Promise<RestoreImagesResult> {
  if (!ids.length) return { restored: 0, images: [] };
  const returnIds = options.returnIds !== false;
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE metadata
          SET status='ready', deleted_at=NULL, updated_at=now()
        WHERE id = ANY($1::uuid[]) AND status='deleted' AND purge_state='idle'
        ${returnIds ? "RETURNING id" : ""}`,
      [ids]
    );
    const images = result.rows as RestoredImage[];
    const restored = Number(result.rowCount ?? 0);
    if (restored) await bumpReadyImageRevision(client);
    return { restored, images };
  });
}
