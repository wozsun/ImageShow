import type { CompletedIngestionImageDto } from "@imageshow/shared/browser";
import { ApiError } from "../../core/api-error.ts";
import { databaseConnectionFailureReason } from "../../core/database/connection-error.ts";
import { pool, type DatabaseReader } from "../../core/database/pools.ts";
import { logger } from "../../core/logger.ts";
import {
  ingestionImageItemsWithTags,
  ingestionImagePresentationColumnsWithTags,
  type IngestionImageRecordWithTags
} from "../presenter.ts";

export type CommittedIngestionResult = Readonly<{
  image_id: string;
  image_time: string;
  created_by: string;
  item: CompletedIngestionImageDto;
}>;

export function committedIngestionResultForOwner(
  results: ReadonlyMap<string, CommittedIngestionResult>,
  imageId: string,
  owner: string
) {
  const result = results.get(imageId.toLowerCase());
  return result?.created_by === owner ? result : undefined;
}

export async function readCommittedIngestionResultsByImageIds(
  imageIds: readonly string[],
  reader: DatabaseReader = pool
) {
  const uniqueIds = [...new Set(imageIds.map((imageId) => imageId.toLowerCase()))];
  if (!uniqueIds.length) return new Map<string, CommittedIngestionResult>();
  let rows: Array<IngestionImageRecordWithTags & { created_by: string }>;
  let items: CompletedIngestionImageDto[];
  try {
    rows = (await reader.query<IngestionImageRecordWithTags & { created_by: string }>(
      `SELECT ${ingestionImagePresentationColumnsWithTags}, created_by
         FROM metadata
        WHERE id = ANY($1::uuid[])`,
      [uniqueIds]
    )).rows;
    // URL projection can read PostgreSQL again when the storage registry is
    // cold. Its connection failures belong to the same completed-result read.
    items = await ingestionImageItemsWithTags(rows);
  } catch (error) {
    const reason = databaseConnectionFailureReason(error);
    if (!reason) throw error;
    logger.warn("ingestion_results_database_unavailable", { reason });
    const unavailable = new ApiError(
      503,
      "database_unavailable",
      "PostgreSQL unavailable",
      { dependency: "postgresql" }
    );
    unavailable.cause = error;
    throw unavailable;
  }
  const rowsById = new Map(rows.map((row) => [row.id.toLowerCase(), row]));
  return new Map(items.map((item) => [
    item.id.toLowerCase(),
    {
      image_id: item.id.toLowerCase(),
      image_time: new Date(rowsById.get(item.id.toLowerCase())!.image_time)
        .toISOString(),
      created_by: rowsById.get(item.id.toLowerCase())!.created_by,
      item
    }
  ]));
}
