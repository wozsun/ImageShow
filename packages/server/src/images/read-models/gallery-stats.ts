import {
  brightnesses, devices, type Brightness, type Device, type GalleryStatsDto
} from "@imageshow/shared/browser";
import { coalesce } from "../../core/coalesce.ts";
import {
  withPublicDatabaseRead, type PublicDatabaseReadAccess
} from "../../core/database/public-fallback.ts";
import { pool } from "../../core/database/pools.ts";
import {
  readReadyImageCountSnapshot, type ReadyImageCountSnapshot
} from "../ready-cache/counts/query.ts";
import { resolveImageFilterPlan } from "../filter-plan.ts";
import {
  readGalleryStatsVocabulary, readPublicGalleryCountSnapshot, type GalleryStatsVocabulary
} from "./gallery-stats-sql.ts";

export type GalleryStatsQuery = {
  device?: Device;
  brightness?: Brightness;
  theme?: string;
  tag?: string | string[];
  author?: string;
};

function presentGalleryStats(
  snapshot: ReadyImageCountSnapshot,
  vocabulary: GalleryStatsVocabulary
): GalleryStatsDto {
  return {
    total_images: snapshot.total,
    matching_images: snapshot.matching,
    devices: devices.map((device) => ({
      device,
      image_count: snapshot.devices[device] ?? 0
    })),
    brightnesses: brightnesses.map((brightness) => ({
      brightness,
      image_count: snapshot.brightnesses[brightness] ?? 0
    })),
    categories: devices.flatMap((device) => (
      brightnesses.map((brightness) => ({
        device,
        brightness,
        image_count: snapshot.axes[`${device}:${brightness}`] ?? 0
      }))
    )),
    // Membership comes from the count snapshot, even when filtered counts are zero.
    themes: vocabulary.themes
      .filter((entry) => Object.hasOwn(snapshot.themes, entry.slug))
      .map((entry) => ({ ...entry, image_count: snapshot.themes[entry.slug] ?? 0 })),
    tags: vocabulary.tags
      .filter((entry) => Object.hasOwn(snapshot.tags, entry.slug))
      .map((entry) => ({ ...entry, image_count: snapshot.tags[entry.slug] ?? 0 })),
    authors: vocabulary.authors
      .filter((entry) => Object.hasOwn(snapshot.authors, entry.slug))
      .map((entry) => ({ ...entry, image_count: snapshot.authors[entry.slug] ?? 0 }))
  };
}

async function getPublicGalleryStatsWithAccess(
  query: GalleryStatsQuery,
  signal: AbortSignal | undefined,
  database: PublicDatabaseReadAccess
): Promise<GalleryStatsDto> {
  const plan = await resolveImageFilterPlan(query, database);
  const cached = await readReadyImageCountSnapshot(plan, signal, Boolean(database.reader));
  if (cached.cached) {
    return presentGalleryStats(cached.value, await readGalleryStatsVocabulary(database));
  }
  if (database.reader) {
    const result = await readPublicGalleryCountSnapshot(
      plan, database.reader, signal ?? new AbortController().signal, cached.context
    );
    return presentGalleryStats(result.snapshot, result.vocabulary);
  }
  const load = async () => {
    const client = await pool.connect();
    try {
      const result = await readPublicGalleryCountSnapshot(
        plan, client, new AbortController().signal, cached.context
      );
      return presentGalleryStats(result.snapshot, result.vocabulary);
    } finally {
      client.release();
    }
  };
  return coalesce(`gallery-stats:postgres:${plan.signature}`, load);
}

export function getPublicGalleryStats(
  query: GalleryStatsQuery = {},
  signal?: AbortSignal
): Promise<GalleryStatsDto> {
  return signal
    ? coalesce(`gallery-stats:public:${JSON.stringify([
        query.device, query.brightness, query.theme, query.tag, query.author
      ])}`, (sharedSignal) => withPublicDatabaseRead(
        sharedSignal,
        (database, databaseSignal) => getPublicGalleryStatsWithAccess(query, databaseSignal, database)
      ), signal)
    : getPublicGalleryStatsWithAccess(query, undefined, {});
}
