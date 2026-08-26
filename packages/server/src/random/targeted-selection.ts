import { appConfig } from "@imageshow/shared";
import {
  publicPgFallbackWorkLimitExceeded,
  type PublicDatabaseReadAccess
} from "../core/database/public-fallback.ts";
import { pool, type DatabaseReader } from "../core/database/pools.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import { readTargetedReadyImages } from "../images/ready-cache/query.ts";
import {
  readyImageCacheItemFromRow,
  type ReadyImageSourceRow
} from "../images/ready-cache/model.ts";
import { readyImageSourceColumns } from "../images/ready-cache/source.ts";
import type { SelectedReadyImage } from "./selection-model.ts";

function shuffled(items: SelectedReadyImage[]) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [
      result[swapIndex]!,
      result[index]!
    ];
  }
  return result;
}

export async function pickTargetedImages(
  ids: string[],
  limit: number,
  signal?: AbortSignal,
  database: PublicDatabaseReadAccess = {}
): Promise<SelectedReadyImage[] | Response> {
  signal?.throwIfAborted();
  const cached = await readTargetedReadyImages(ids);
  let candidates: SelectedReadyImage[];
  if (cached.cached) {
    candidates = cached.value;
  } else {
    const maximumCandidates =
      appConfig.publicPgFallback.maximumTargetedCandidates;
    const fullIds = ids.filter((id) => id.length > 12);
    const suffixes = ids.filter((id) => id.length === 12);
    const read = async (reader: DatabaseReader) => (await reader.query(
      `WITH candidate_ids AS MATERIALIZED (
         SELECT id
           FROM metadata
          WHERE status='ready' AND id=ANY($1::uuid[])
         UNION ALL
         SELECT id
           FROM metadata
          WHERE status='ready'
            AND right(id::text, 12)=ANY($2::text[])
            AND NOT (id=ANY($1::uuid[]))
          LIMIT $3
       )
       SELECT ${readyImageSourceColumns}
         FROM metadata m
         JOIN candidate_ids candidate ON candidate.id=m.id
        ORDER BY m.id`,
      [fullIds, suffixes, maximumCandidates + 1]
    )).rows as ReadyImageSourceRow[];
    const rows = await read(database.reader ?? pool);
    if (rows.length > maximumCandidates) {
      throw publicPgFallbackWorkLimitExceeded(
        "Targeted random selection exceeds the supported candidate limit"
      );
    }
    candidates = rows.map(readyImageCacheItemFromRow);
  }
  signal?.throwIfAborted();
  if (!candidates.length) {
    return apiErrorResponse({
      status: 404,
      message: "Not Found: No available images for the requested ids"
    });
  }
  return shuffled(candidates).slice(0, limit);
}
