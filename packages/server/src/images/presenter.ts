import {
  type AdminImageDetailItemDto,
  type AdminImageListItemDto,
  type CompletedIngestionImageDto,
  type Brightness,
  type Device,
  type EditableImageSnapshotDto,
  type GalleryImageCardDto,
  type ShowImageCardDto,
  type PublicImageDetailDto
} from "@imageshow/shared/browser";
import { storageBackendLabel } from "../storage/backends/label.ts";
import type { StorageConfig } from "../storage/backends/config.ts";
import {
  getStorageBackendConfigs,
  type StorageRegistryAccess
} from "../storage/backends/registry.ts";
import {
  publicImageUrl,
  publicImageUrlsForConfig,
  publicThumbnailUrlForConfig
} from "../storage/objects/public-urls.ts";
import { imageHasTrashPurgeJobSql } from "./trash/purge-state.ts";
import { adminOriginalAccessUrl } from "./serving/original-link.ts";

type DatabaseNumber = number | string;
type DatabaseTimestamp = string | Date;
type PublicImageTimeRecord = { image_time: DatabaseTimestamp } | { sort_score: number };

type AdminImageCommonRecord = {
  id: string;
  device: Device;
  brightness: Brightness;
  theme: string | null;
  width: DatabaseNumber;
  height: DatabaseNumber;
  ext: string;
  storage_slug: string;
  author: string | null;
  title: string;
  description: string;
  source: string;
  original: string;
};

type IngestionImageRecord = AdminImageCommonRecord & {
  image_size: DatabaseNumber;
  md5: string;
  image_time: DatabaseTimestamp;
};

export type IngestionImageRecordWithTags = IngestionImageRecord & { tags: string[] };

/** Exact row returned by the full admin image-list projection. */
export type ImageRecord = IngestionImageRecord & {
  status: "ready" | "deleted";
  deleted_at: DatabaseTimestamp | null;
  purge_pending: boolean;
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
 * Shared image fields for formal Ingestion results and admin list rows.
 */
const ingestionImagePresentationColumns = [
  "id",
  "device",
  "brightness",
  "theme",
  "width",
  "height",
  "image_size",
  "md5",
  "ext",
  "storage_slug",
  "author",
  "title",
  "description",
  "source",
  "original",
  "image_time"
].join(", ");

export const adminImageListPresentationColumns = [
  ingestionImagePresentationColumns,
  "status",
  "deleted_at",
  "created_at",
  "updated_at"
].join(", ");

/**
 * Read tags in the same PostgreSQL statement as compact image projections so
 * metadata and associations share one statement-level MVCC snapshot.
 */
export const imageTagsPresentationColumn = `ARRAY(
  SELECT it.tag_slug
    FROM image_tag it
   WHERE it.image_id = metadata.id
   ORDER BY it.tag_slug
) AS tags`;

export const adminImageListPresentationColumnsWithTags = [
  adminImageListPresentationColumns,
  `(status='deleted' AND ${imageHasTrashPurgeJobSql}) AS purge_pending`,
  imageTagsPresentationColumn
].join(", ");

export const ingestionImagePresentationColumnsWithTags = [
  ingestionImagePresentationColumns,
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
  "ext",
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
  "ext",
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
  | "storage_slug"
  | "author"
  | "title"
> &
  PublicImageTimeRecord;

export type PublicImageDetailRecord = Pick<
  AdminImageCommonRecord,
  | "id"
  | "ext"
  | "storage_slug"
  | "description"
  | "source"
  | "original"
  | "author"
  | "device"
  | "brightness"
  | "theme"
> &
  PublicImageTimeRecord & { tags: string[] };

export type PublicShowImageRecord = Pick<
  PublicImageCardRecord,
  "id" | "title" | "width" | "height" | "storage_slug"
>;

type PublicImageUrlRecord = Pick<AdminImageCommonRecord, "storage_slug">;

function storageConfigsForRows(
  rows: readonly PublicImageUrlRecord[],
  access: StorageRegistryAccess = {}
) {
  return getStorageBackendConfigs(
    rows.map((row) => row.storage_slug),
    access
  );
}

function serializeTimestamp(value: DatabaseTimestamp) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function serializePublicImageTime(row: PublicImageTimeRecord) {
  return "sort_score" in row
    ? new Date(Math.floor(row.sort_score / 1_000)).toISOString()
    : serializeTimestamp(row.image_time);
}

function serializeNullableTimestamp(value: DatabaseTimestamp | null) {
  return value === null ? null : serializeTimestamp(value);
}

function presentImageBase(
  row: AdminImageCommonRecord,
  tags: string[],
  configs: ReadonlyMap<string, StorageConfig>
) {
  const urls = publicImageUrlsForConfig(row, configs.get(row.storage_slug)!);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    source: row.source || null,
    device: row.device,
    brightness: row.brightness,
    theme: row.theme,
    author: row.author ?? "",
    tags,
    thumb_url: urls.thumb_url,
    object_url: urls.object_url,
    width: Number(row.width),
    height: Number(row.height),
    storage_slug: row.storage_slug
  };
}

function presentAdminImageBase(
  row: AdminImageCommonRecord,
  tags: string[],
  configs: ReadonlyMap<string, StorageConfig>
) {
  const base = presentImageBase(row, tags, configs);
  return {
    ...base,
    original_url: adminOriginalAccessUrl(row.id, row.original, base.object_url)
  };
}

export async function ingestionImageItemsWithTags(rows: IngestionImageRecordWithTags[]) {
  if (!rows.length) return [];
  const configs = await storageConfigsForRows(rows);
  return rows.map((row): CompletedIngestionImageDto => ({
    ...presentImageBase(row, row.tags, configs),
    original: row.original,
    md5: row.md5,
    image_size: Number(row.image_size),
    image_time: serializeTimestamp(row.image_time)
  }));
}

function adminImageListItem(
  row: ImageRecord,
  tags: string[],
  configs: ReadonlyMap<string, StorageConfig>
): AdminImageListItemDto {
  const base = presentAdminImageBase(row, tags, configs);
  return {
    ...base,
    original: row.original,
    status: row.status,
    purge_pending: row.purge_pending,
    ext: row.ext,
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
  const configs = await storageConfigsForRows(rows);
  return rows.map((row) => adminImageListItem(row, row.tags, configs));
}

export async function adminImageDetailItemsWithTags(rows: AdminImageDetailRecordWithTags[]) {
  if (!rows.length) return [];
  const configs = await storageConfigsForRows(rows);
  return rows.map((row): AdminImageDetailItemDto => {
    const { storage_slug: storageSlug, ...base } = presentAdminImageBase(row, row.tags, configs);
    return {
      ...base,
      md5: row.md5,
      storage_label: storageBackendLabel({
        storage_slug: storageSlug,
        storage_display_name: row.storage_display_name
      }),
      image_time: serializeTimestamp(row.image_time),
      created_at: serializeTimestamp(row.created_at),
      updated_at: serializeTimestamp(row.updated_at)
    };
  });
}

export async function editableImageSnapshotsWithTags(rows: EditableImageSnapshotRecordWithTags[]) {
  if (!rows.length) return [];
  const configs = await storageConfigsForRows(rows);
  return rows.map((row): EditableImageSnapshotDto => {
    const base = presentAdminImageBase(row, row.tags, configs);
    return {
      ...base,
      original: row.original,
      image_size: Number(row.image_size),
      ext: row.ext
    };
  });
}

export async function publicImageDetail(
  row: PublicImageDetailRecord,
  access: StorageRegistryAccess = {},
  includeOriginal = false
): Promise<PublicImageDetailDto> {
  const objectUrl = await publicImageUrl(row, row.storage_slug, access);
  return {
    id: row.id,
    author: row.author ?? "",
    device: row.device,
    brightness: row.brightness,
    theme: row.theme,
    tags: row.tags,
    image_time: serializePublicImageTime(row),
    description: row.description,
    source: row.source || null,
    object_url: objectUrl,
    original_url: includeOriginal ? adminOriginalAccessUrl(row.id, row.original, objectUrl) : null
  };
}

function publicShowImageCard(
  row: PublicShowImageRecord,
  configs: ReadonlyMap<string, StorageConfig>
): ShowImageCardDto {
  return {
    id: row.id,
    title: row.title,
    thumb_url: publicThumbnailUrlForConfig(row.id, configs.get(row.storage_slug)!),
    width: Number(row.width),
    height: Number(row.height)
  };
}

export async function publicShowImageCards(
  rows: PublicShowImageRecord[],
  access: StorageRegistryAccess = {}
) {
  if (!rows.length) return [];
  const configs = await storageConfigsForRows(rows, access);
  return rows.map((row) => publicShowImageCard(row, configs));
}

function publicImageCard(
  row: PublicImageCardRecord,
  tags: string[],
  configs: ReadonlyMap<string, StorageConfig>
): GalleryImageCardDto {
  return {
    ...publicShowImageCard(row, configs),
    device: row.device,
    brightness: row.brightness,
    theme: row.theme,
    author: row.author ?? "",
    tags,
    image_time: serializePublicImageTime(row)
  };
}

export async function publicImageCardsWithTags(
  rows: Array<PublicImageCardRecord & { tags: string[] }>,
  access: StorageRegistryAccess = {}
) {
  if (!rows.length) return [];
  const configs = await storageConfigsForRows(rows, access);
  return rows.map((row) => publicImageCard(row, row.tags, configs));
}
