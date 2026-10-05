import { hash } from "node:crypto";
import { appConfig } from "@imageshow/shared";
import {
  publicPgFallbackWorkLimitExceeded,
  type PublicDatabaseReadAccess
} from "../core/database/public-fallback.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import {
  imageMatchesFilterPlan,
  type ImageFilterPlan
} from "../images/filter-plan.ts";
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

/** Same seed and candidates give the same order; a larger limit keeps the prefix. */
function seededOrder(items: SelectedReadyImage[], seed: string) {
  return items
    .map((item) => ({
      item,
      key: hash("sha256", JSON.stringify(["random-id", seed, item.id]), "hex")
    }))
    // Hex digests sort by code unit; no locale collation is involved.
    .sort((left, right) => (left.key < right.key ? -1 : 1))
    .map(({ item }) => item);
}

/** Random order that serves recently returned images only after the rest. */
function recencyAwareOrder(items: SelectedReadyImage[], recent: ReadonlySet<string>) {
  const order = shuffled(items);
  return [
    ...order.filter((item) => !recent.has(item.id)),
    ...order.filter((item) => recent.has(item.id))
  ];
}

async function readTargetedCandidates(
  ids: string[],
  database: PublicDatabaseReadAccess
): Promise<SelectedReadyImage[]> {
  const cached = await readTargetedReadyImages(ids);
  if (cached.cached) return cached.value;
  const maximumCandidates = appConfig.publicPgFallback.maximumTargetedCandidates;
  const fullIds = ids.filter((id) => id.length > 12);
  const suffixes = ids.filter((id) => id.length === 12);
  const rows = (
    await database.reader.query(
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
    )
  ).rows as ReadyImageSourceRow[];
  if (rows.length > maximumCandidates) {
    throw publicPgFallbackWorkLimitExceeded(
      "Targeted random selection exceeds the supported candidate limit"
    );
  }
  return rows.map(readyImageCacheItemFromRow);
}

/**
 * Picks from the requested ids that still exist, narrowed by the same filter
 * plan as untargeted requests. An empty result after filtering is left to the
 * caller's filter 404.
 */
export async function pickTargetedImages(
  input: {
    ids: string[];
    plan: ImageFilterPlan;
    limit: number;
    seed: string | null;
    recent: ReadonlySet<string>;
  },
  signal: AbortSignal,
  database: PublicDatabaseReadAccess
): Promise<SelectedReadyImage[] | Response> {
  signal.throwIfAborted();
  const candidates = await readTargetedCandidates(input.ids, database);
  signal.throwIfAborted();
  if (!candidates.length) {
    return apiErrorResponse({
      status: 404,
      message: "Not Found: No available images for the requested ids"
    });
  }
  const matching = candidates.filter((item) => imageMatchesFilterPlan(item, input.plan));
  const ordered = input.seed === null
    ? recencyAwareOrder(matching, input.recent)
    : seededOrder(matching, input.seed);
  return ordered.slice(0, input.limit);
}
