import {
  brightnesses, devices, type GalleryStatsDto
} from "@imageshow/shared/browser";
import { coalesce } from "../../core/coalesce.ts";
import {
  withPublicDatabaseRead,
  type PublicDatabaseReadAccess
} from "../../core/database/public-fallback.ts";
import {
  readReadyImageCountSnapshot,
  type ReadyImageCountSnapshot
} from "../ready-cache/counts/query.ts";
import { resolveGalleryStatsPlan, type GalleryStatsQuery } from "./gallery-stats-plan.ts";
import { readPublicGalleryCountSnapshot } from "./gallery-stats-sql.ts";

// Display names and order come from the session facets on the client. Sorting
// by slug keeps the bytes, and so the ETag, identical across Redis and PostgreSQL.
function memberCounts(counts: Record<string, number>) {
  return Object.keys(counts)
    .sort()
    .map((slug) => ({ slug, image_count: counts[slug]! }));
}

function presentGalleryStats(
  snapshot: ReadyImageCountSnapshot,
  query: GalleryStatsQuery
): GalleryStatsDto {
  return {
    total_images: snapshot.total,
    matching_images: snapshot.matching,
    ...(snapshot.tagGroups
      ? {
          tag_groups: snapshot.tagGroups.map((image_count, index) => ({
            tag: typeof query.tag === "string" ? query.tag : query.tag![index]!,
            image_count
          }))
        }
      : {}),
    devices: devices.map((device) => ({
      device,
      image_count: snapshot.devices[device] ?? 0
    })),
    brightnesses: brightnesses.map((brightness) => ({
      brightness,
      image_count: snapshot.brightnesses[brightness] ?? 0
    })),
    // Membership comes from the count snapshot, even when filtered counts are zero.
    themes: memberCounts(snapshot.themes),
    tags: memberCounts(snapshot.tags),
    authors: memberCounts(snapshot.authors)
  };
}

async function getPublicGalleryStatsWithAccess(
  query: GalleryStatsQuery,
  signal: AbortSignal,
  database: PublicDatabaseReadAccess
): Promise<GalleryStatsDto> {
  const { plan, tagCounts } = await resolveGalleryStatsPlan(query, database);
  const cached = await readReadyImageCountSnapshot(
    plan,
    signal,
    tagCounts
  );
  if (cached.cached) return presentGalleryStats(cached.value, query);
  const snapshot = await readPublicGalleryCountSnapshot(
    plan,
    database.reader,
    signal,
    cached.context,
    tagCounts
  );
  return presentGalleryStats(snapshot, query);
}

export function getPublicGalleryStats(
  query: GalleryStatsQuery,
  signal: AbortSignal
): Promise<GalleryStatsDto> {
  return coalesce(
    `gallery-stats:public:${JSON.stringify([
      query.device,
      query.brightness,
      query.theme,
      query.tag,
      query.author,
      query.tag_scope
    ])}`,
    (sharedSignal) =>
      withPublicDatabaseRead(sharedSignal, (database, databaseSignal) =>
        getPublicGalleryStatsWithAccess(query, databaseSignal, database)
      ),
    signal
  );
}
