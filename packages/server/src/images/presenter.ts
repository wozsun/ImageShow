import {
  type AdminImageDetailItemDto,
  type AdminImageListItemDto,
  type Brightness,
  type Device,
  type EditableImageSnapshotDto,
  type GalleryImageCardDto,
  type PublicImageDetailDto
} from "@imageshow/shared/browser";
import type { DatabaseReader } from "../core/database/pools.ts";
import type {
  PublicDatabaseReadAccess
} from "../core/database/public-fallback.ts";
import { storageBackendLabel } from "../storage/backends/label.ts";
import { listStorageBackends } from "../storage/backends/registry.ts";
import { publicImageUrls } from "../storage/objects/public-urls.ts";
import { getTagsForImages } from "../tags/query.ts";
import { getTagVocab, getThemeVocab } from "../vocab/vocab-cache.ts";
import { createGallerySubtitleFormatter } from "./gallery-card-display.ts";
import { hasDistinctOriginalUrl } from "./original-link.ts";

type DatabaseNumber = number | string;
type DatabaseTimestamp = string | Date;
type GallerySubtitleFormatter = ReturnType<
  typeof createGallerySubtitleFormatter
>;

type AdminImageCommonRecord = {
  id: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  width: DatabaseNumber;
  height: DatabaseNumber;
  object_key: string;
  storage_slug: string;
  author: string | null;
  title: string;
  description: string;
  source: string;
  original: string;
};

/** Exact row returned by the full admin image-list projection. */
export type ImageRecord = AdminImageCommonRecord & {
  image_size: DatabaseNumber;
  md5: string;
  status: "ready" | "deleted";
  deleted_at: DatabaseTimestamp | null;
  purge_job_id: string | null;
  image_time: DatabaseTimestamp;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
};

export type ImageRecordWithTags = ImageRecord & { tags: string[] };

/** Exact row returned by the compact overview detail projection. */
export type AdminImageDetailRecordWithTags = AdminImageCommonRecord & {
  md5: string;
  storage_display_name: string;
  image_time: DatabaseTimestamp;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
  tags: string[];
};

/** Exact row returned by the editable image snapshot projection. */
export type EditableImageSnapshotRecordWithTags = AdminImageCommonRecord & {
  image_size: DatabaseNumber;
  tags: string[];
};

/**
 * Columns required by the full admin list, duplicate results and Ingestion
 * commit response. Keep this list aligned with ImageRecord.
 */
export const adminImageListPresentationColumns = [
  "id",
  "device",
  "brightness",
  "theme",
  "width",
  "height",
  "image_size",
  "md5",
  "object_key",
  "storage_slug",
  "author",
  "title",
  "description",
  "source",
  "original",
  "status",
  "deleted_at",
  "purge_job_id",
  "image_time",
  "created_at",
  "updated_at"
].join(", ");

/**
 * Read tags in the same PostgreSQL statement as compact image projections so
 * metadata and associations share one statement-level MVCC snapshot.
 */
const imageTagsPresentationColumn = `ARRAY(
  SELECT it.tag_slug
    FROM image_tag it
   WHERE it.image_id = metadata.id
   ORDER BY it.tag_slug
) AS tags`;

export const adminImageListPresentationColumnsWithTags = [
  adminImageListPresentationColumns,
  imageTagsPresentationColumn
].join(", ");

export const adminImageDetailPresentationColumnsWithTags = [
  "id",
  "device",
  "brightness",
  "theme",
  "width",
  "height",
  "md5",
  "object_key",
  "storage_slug",
  "author",
  "title",
  "description",
  "source",
  "original",
  "image_time",
  "created_at",
  "updated_at",
  imageTagsPresentationColumn
].join(", ");

export const editableImagePresentationColumnsWithTags = [
  "id",
  "device",
  "brightness",
  "theme",
  "width",
  "height",
  "image_size",
  "object_key",
  "storage_slug",
  "author",
  "title",
  "description",
  "source",
  "original",
  imageTagsPresentationColumn
].join(", ");

export type PublicImageCardRecord = Pick<
  AdminImageCommonRecord,
  | "id"
  | "device"
  | "brightness"
  | "theme"
  | "width"
  | "height"
  | "object_key"
  | "storage_slug"
  | "author"
  | "title"
  | "original"
> & {
  image_time: DatabaseTimestamp;
};

export type PublicImageDetailRecord = Pick<
  AdminImageCommonRecord,
  "id" | "object_key" | "storage_slug" | "description" | "source"
>;

type PublicImageUrlRecord = Pick<
  AdminImageCommonRecord,
  "object_key" | "storage_slug"
>;

async function publicUrlsForRow(
  row: PublicImageUrlRecord,
  access: PublicDatabaseReadAccess = {}
) {
  const storageSlug = row.storage_slug;
  const urls = await publicImageUrls(row.object_key, storageSlug, access);
  return { storageSlug, urls };
}

function serializeTimestamp(value: DatabaseTimestamp) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function serializeNullableTimestamp(value: DatabaseTimestamp | null) {
  return value === null ? null : serializeTimestamp(value);
}

async function presentAdminImageBase(
  row: AdminImageCommonRecord,
  tags: string[]
) {
  const { storageSlug, urls } = await publicUrlsForRow(row);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    source: row.source,
    device: row.device,
    brightness: row.brightness,
    theme: row.theme,
    author: row.author ?? "",
    tags,
    thumb_url: urls.thumb_url,
    object_url: urls.object_url,
    width: Number(row.width),
    height: Number(row.height),
    storage_slug: storageSlug
  };
}

async function adminImageListItem(
  row: ImageRecord,
  tags: string[]
): Promise<AdminImageListItemDto> {
  const base = await presentAdminImageBase(row, tags);
  return {
    ...base,
    original: row.original,
    diff_original: hasDistinctOriginalUrl(row.original, base.object_url),
    status: row.status,
    purge_pending: row.purge_job_id !== null,
    object_key: row.object_key,
    md5: row.md5,
    image_size: Number(row.image_size),
    deleted_at: serializeNullableTimestamp(row.deleted_at),
    image_time: serializeTimestamp(row.image_time),
    created_at: serializeTimestamp(row.created_at),
    updated_at: serializeTimestamp(row.updated_at)
  };
}

export async function adminImageListItemsWithTags(rows: ImageRecordWithTags[]) {
  if (!rows.length) return [];
  return Promise.all(rows.map((row) => adminImageListItem(
    row,
    row.tags
  )));
}

export async function adminImageDetailItemsWithTags(
  rows: AdminImageDetailRecordWithTags[]
) {
  if (!rows.length) return [];
  return Promise.all(rows.map(async (row): Promise<AdminImageDetailItemDto> => {
    const {
      storage_slug: storageSlug,
      ...base
    } = await presentAdminImageBase(row, row.tags);
    return {
      ...base,
      diff_original: hasDistinctOriginalUrl(row.original, base.object_url),
      md5: row.md5,
      storage_label: storageBackendLabel({
        storage_slug: storageSlug,
        storage_display_name: row.storage_display_name
      }),
      image_time: serializeTimestamp(row.image_time),
      created_at: serializeTimestamp(row.created_at),
      updated_at: serializeTimestamp(row.updated_at)
    };
  }));
}

export async function editableImageSnapshotsWithTags(
  rows: EditableImageSnapshotRecordWithTags[]
) {
  if (!rows.length) return [];
  const gallerySubtitle = await loadGallerySubtitleFormatter();
  return Promise.all(rows.map(async (row): Promise<EditableImageSnapshotDto> => {
    const base = await presentAdminImageBase(row, row.tags);
    return {
      ...base,
      subtitle: gallerySubtitle({ theme: row.theme, tags: row.tags }),
      original: row.original,
      image_size: Number(row.image_size),
      object_key: row.object_key
    };
  }));
}

export async function publicImageDetail(
  row: PublicImageDetailRecord,
  access: PublicDatabaseReadAccess = {}
): Promise<PublicImageDetailDto> {
  const { urls } = await publicUrlsForRow(row, access);
  return {
    id: row.id,
    description: row.description,
    source: row.source,
    object_url: urls.object_url
  };
}

async function publicImageCard(
  row: PublicImageCardRecord,
  tags: string[],
  access: PublicDatabaseReadAccess,
  gallerySubtitle: GallerySubtitleFormatter
): Promise<GalleryImageCardDto> {
  const { urls } = await publicUrlsForRow(row, access);
  const original = row.original;
  return {
    id: row.id,
    subtitle: gallerySubtitle({ theme: row.theme, tags }),
    device: row.device,
    brightness: row.brightness,
    theme: row.theme,
    author: row.author ?? "",
    width: Number(row.width),
    height: Number(row.height),
    title: row.title,
    tags,
    diff_original: hasDistinctOriginalUrl(original, urls.object_url),
    image_time: serializeTimestamp(row.image_time),
    thumb_url: urls.thumb_url
  };
}

export async function publicImageCards(
  rows: PublicImageCardRecord[],
  reader?: DatabaseReader
) {
  if (!rows.length) return [];
  const database = { reader };
  const [tagMap, gallerySubtitle] = await Promise.all([
    getTagsForImages(rows.map((row) => row.id), reader),
    loadGallerySubtitleFormatter(database),
    listStorageBackends(database)
  ]);
  return Promise.all(rows.map((row) => publicImageCard(
    row,
    tagMap.get(row.id) ?? [],
    database,
    gallerySubtitle
  )));
}

export function publicImageCardsWithTags(
  rows: Array<PublicImageCardRecord & { tags: string[] }>,
  access: PublicDatabaseReadAccess = {}
) {
  return (async () => {
    if (!rows.length) return [];
    const [gallerySubtitle] = await Promise.all([
      loadGallerySubtitleFormatter(access),
      listStorageBackends(access)
    ]);
    return Promise.all(rows.map((row) => publicImageCard(
      row,
      row.tags,
      access,
      gallerySubtitle
    )));
  })();
}

async function loadGallerySubtitleFormatter(
  access: PublicDatabaseReadAccess = {}
) {
  const [themes, tags] = await Promise.all([
    getThemeVocab(access),
    getTagVocab(access)
  ]);
  return createGallerySubtitleFormatter(themes, tags);
}
