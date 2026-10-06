import { imageVariantUrl } from "@imageshow/shared/browser";
import {
  imageVariantColumns,
  imageVariantByteSizeColumns,
  presentImageVariants,
  presentImageVariantByteSizes,
  type ImageVariantRecord,
  type ImageVariantByteSizeRecord
} from "./variants/record.ts";
import {
  type AdminImageDetailItemDto,
  type AdminImageListItemDto,
  type CompletedIngestionImageDto,
  type Brightness,
  type Device,
  type EditableImageSnapshotDto,
  type GalleryImageCardDto,
  type ShowImageCardDto,
  type PublicImageDetailDto,
  type PublicImageView
} from "@imageshow/shared/browser";
import { storageBackendLabel } from "../storage/backends/label.ts";
import type { StorageConfig } from "../storage/backends/config.ts";
import {
  getStorageBackendConfigs,
  type StorageRegistryAccess
} from "../storage/backends/registry.ts";
import {
  publicImageBaseUrl
} from "../storage/objects/public-urls.ts";
import { imageHasTrashPurgeJobSql } from "./trash/purge-state.ts";
import { adminOriginalAccessUrl } from "./serving/original-link.ts";

type DatabaseNumber = number | string;
type DatabaseTimestamp = string | Date;
type PublicImageTimeRecord = { image_time: DatabaseTimestamp } | { sort_score: number };

type ImageMetadataRecord = {
  id: string;
  device: Device;
  brightness: Brightness;
  theme: string | null;
  storage_slug: string;
  author: string | null;
  title: string;
  description: string;
  source: string;
  original: string;
};

type AdminImageCommonRecord = ImageMetadataRecord & ImageVariantRecord;

type IngestionImageRecord = AdminImageCommonRecord & {
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
export type AdminImageDetailRecordWithTags = ImageMetadataRecord & ImageVariantByteSizeRecord & {
  storage_display_name: string;
  image_time: DatabaseTimestamp;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
  tags: string[];
};

/** Exact row returned by the editable image snapshot projection. */
export type EditableImageSnapshotRecordWithTags = AdminImageCommonRecord & {
  tags: string[];
};

/** Image metadata columns around the variant column set chosen by the caller. */
function imageMetadataPresentationColumns(variantColumns: string) {
  return [
    "id",
    "device",
    "brightness",
    "theme",
    variantColumns,
    "storage_slug",
    "author",
    "title",
    "description",
    "source",
    "original"
  ].join(", ");
}

/**
 * Shared image fields for formal Ingestion results and admin list rows.
 */
const ingestionImagePresentationColumns = [
  imageMetadataPresentationColumns(imageVariantColumns),
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
  imageMetadataPresentationColumns(imageVariantByteSizeColumns),
  "image_time",
  "created_at",
  "updated_at",
  imageTagsPresentationColumn
].join(", ");

export const editableImagePresentationColumnsWithTags = [
  imageMetadataPresentationColumns(imageVariantColumns),
  imageTagsPresentationColumn
].join(", ");

export type PublicImageCardRecord = Pick<
  AdminImageCommonRecord,
  | "id"
  | "theme"
  | "storage_slug"
  | "title"
> & { width: DatabaseNumber; height: DatabaseNumber };

export type PublicImageDetailRecord = Pick<
  AdminImageCommonRecord,
  | "id"
  | "device"
  | "storage_slug"
  | "description"
  | "source"
  | "original"
  | "author"
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
  access?: StorageRegistryAccess
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
  row: ImageMetadataRecord & { tags: string[] },
  configs: ReadonlyMap<string, StorageConfig>
) {
  const base_url = publicImageBaseUrl(configs.get(row.storage_slug)!);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    source: row.source || null,
    device: row.device,
    brightness: row.brightness,
    theme: row.theme,
    author: row.author,
    tags: row.tags,
    base_url,
    storage_slug: row.storage_slug
  };
}

function presentAdminImageBase(
  row: ImageMetadataRecord & { tags: string[] },
  configs: ReadonlyMap<string, StorageConfig>
) {
  const base = presentImageBase(row, configs);
  return {
    ...base,
    original_url: adminOriginalAccessUrl(row.id, row.original, imageVariantUrl(base, "large"))
  };
}

export async function ingestionImageItemsWithTags(rows: IngestionImageRecordWithTags[]) {
  if (!rows.length) return [];
  const configs = await storageConfigsForRows(rows);
  return rows.map((row): CompletedIngestionImageDto => ({
    ...presentImageBase(row, configs),
    variants: presentImageVariants(row),
    width: Number(row.s_width),
    height: Number(row.s_height),
    original: row.original,
    large_md5: row.l_md5,
    image_time: serializeTimestamp(row.image_time)
  }));
}

function adminImageListItem(
  row: ImageRecordWithTags,
  configs: ReadonlyMap<string, StorageConfig>
): AdminImageListItemDto {
  const base = presentAdminImageBase(row, configs);
  return {
    ...base,
    original: row.original,
    variants: presentImageVariants(row),
    width: Number(row.s_width),
    height: Number(row.s_height),
    status: row.status,
    purge_pending: row.purge_pending,
    deleted_at: serializeNullableTimestamp(row.deleted_at),
    image_time: serializeTimestamp(row.image_time),
    created_at: serializeTimestamp(row.created_at),
    updated_at: serializeTimestamp(row.updated_at)
  };
}

export async function adminImageListItemsWithTags(rows: ImageRecordWithTags[]) {
  if (!rows.length) return [];
  const configs = await storageConfigsForRows(rows);
  return rows.map((row) => adminImageListItem(
    row,
    configs
  ));
}

export async function adminImageDetailItemsWithTags(rows: AdminImageDetailRecordWithTags[]) {
  if (!rows.length) return [];
  const configs = await storageConfigsForRows(rows);
  return rows.map((row): AdminImageDetailItemDto => {
    const { storage_slug: storageSlug, ...base } = presentAdminImageBase(row, configs);
    return {
      ...base,
      variants: presentImageVariantByteSizes(row),
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
    const base = presentAdminImageBase(row, configs);
    return {
      ...base,
      variants: presentImageVariants(row),
      width: Number(row.s_width),
      height: Number(row.s_height),
      original: row.original
    };
  });
}

export async function publicImageDetail(
  row: PublicImageDetailRecord,
  view: PublicImageView,
  access: StorageRegistryAccess,
  includeOriginal = false
): Promise<PublicImageDetailDto<PublicImageView>> {
  const configs = await storageConfigsForRows([row], access);
  const base_url = publicImageBaseUrl(configs.get(row.storage_slug)!);
  return {
    device: row.device,
    author: row.author,
    brightness: row.brightness,
    ...(view === "show" ? { theme: row.theme, tags: row.tags } : {}),
    image_time: serializePublicImageTime(row),
    description: row.description,
    source: row.source || null,
    base_url,
    original_url: includeOriginal ? adminOriginalAccessUrl(
      row.id,
      row.original,
      imageVariantUrl({ id: row.id, base_url }, "large")
    )
    : null
  };
}

function publicShowImageCard(
  row: PublicShowImageRecord,
  configs: ReadonlyMap<string, StorageConfig>
): ShowImageCardDto {
  return {
    id: row.id,
    title: row.title,
    base_url: publicImageBaseUrl(configs.get(row.storage_slug)!),
    width: Number(row.width),
    height: Number(row.height)
  };
}

export async function publicShowImageCards(
  rows: PublicShowImageRecord[],
  access: StorageRegistryAccess
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
    theme: row.theme,
    tags
  };
}

export async function publicImageCardsWithTags(
  rows: Array<PublicImageCardRecord & { tags: string[] }>,
  access: StorageRegistryAccess
) {
  if (!rows.length) return [];
  const configs = await storageConfigsForRows(rows, access);
  return rows.map((row) => publicImageCard(row, row.tags, configs));
}
