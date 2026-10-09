import {
  imageVariantColumns,
  imageVariantByteSizeColumns,
  presentImageVariants,
  presentImageVariantByteSizes,
  type ImageVariantRecord,
  type ImageVariantByteSizeRecord
} from "./variants/record.ts";
import {
  type AdminImageRecentItemDto,
  type AdminImageListItemDto,
  type CompletedIngestionImageDto,
  type Brightness,
  type Device,
  type EditableImageSnapshotDto,
  type ImageAdminInfoDto,
  type GalleryImageCardDto,
  type ShowImageCardDto,
  type PublicImageDetailDto,
  type PublicImageView
} from "@imageshow/shared/browser";
import { storageBackendLabel } from "../storage/backends/label.ts";
import type { StorageBackendRecord } from "../storage/backends/config.ts";
import {
  getStorageBackendRecords,
  type StorageRegistryAccess
} from "../storage/backends/registry.ts";
import {
  publicImageBaseUrl
} from "../storage/objects/public-urls.ts";
import { imageHasTrashPurgeJobSql } from "./trash/purge-state.ts";

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

type AdminImageCommonRecord = ImageMetadataRecord & ImageVariantByteSizeRecord & {
  s_width: DatabaseNumber;
  s_height: DatabaseNumber;
};

type ImageAdminTimestampsRecord = {
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
};

export type ImageAdminInfoRecord = ImageVariantByteSizeRecord & ImageAdminTimestampsRecord & {
  storage_slug: string;
};

export type IngestionImageRecord = ImageMetadataRecord & ImageVariantRecord & {
  image_time: DatabaseTimestamp;
};

export type IngestionImageRecordWithTags = IngestionImageRecord & { tags: string[] };

/** Exact row returned by the full admin image-list projection. */
export type ImageRecordWithTags = AdminImageCommonRecord & ImageAdminTimestampsRecord & {
  image_time: DatabaseTimestamp;
  status: "ready" | "deleted";
  deleted_at: DatabaseTimestamp | null;
  purge_pending: boolean;
  tags: string[];
};

/** Exact row returned by the compact overview detail projection. */
export type AdminImageDetailRecordWithTags = ImageMetadataRecord & ImageAdminInfoRecord & {
  image_time: DatabaseTimestamp;
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

export const ingestionImagePresentationColumns = [
  imageMetadataPresentationColumns(imageVariantColumns),
  "image_time"
].join(", ");

const editableImagePresentationColumns = [
  imageMetadataPresentationColumns(imageVariantByteSizeColumns),
  "s_width",
  "s_height"
].join(", ");

const imageAdminTimestampColumns = "created_at, updated_at";

export const imageAdminInfoPresentationColumns = [
  imageVariantByteSizeColumns,
  "storage_slug",
  imageAdminTimestampColumns
].join(", ");

export const adminImageListPresentationColumns = [
  editableImagePresentationColumns,
  "image_time",
  "status",
  "deleted_at",
  imageAdminTimestampColumns
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
  imageAdminTimestampColumns,
  imageTagsPresentationColumn
].join(", ");

export const editableImagePresentationColumnsWithTags = [
  editableImagePresentationColumns,
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

function storageRecordsForRows(
  rows: readonly PublicImageUrlRecord[],
  access?: StorageRegistryAccess
) {
  return getStorageBackendRecords(
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

/** Details only show whether an original exists; the raw address stays with editable data. */
function hasOriginal(row: { original: string }) {
  return Boolean(row.original);
}

function presentImageAdminTimestamps(row: ImageAdminTimestampsRecord) {
  return {
    created_at: serializeTimestamp(row.created_at),
    updated_at: serializeTimestamp(row.updated_at)
  };
}

export async function imageAdminInfo(row: ImageAdminInfoRecord): Promise<ImageAdminInfoDto> {
  const storageRecords = await storageRecordsForRows([row]);
  return {
    ...presentImageAdminStorage(row, storageRecords),
    ...presentImageAdminTimestamps(row)
  };
}

/** Every formal-image projection labels storage from the same registry revision used for its URLs. */
function presentImageAdminStorage(
  row: ImageVariantByteSizeRecord & { storage_slug: string },
  storageRecords: ReadonlyMap<string, StorageBackendRecord>
) {
  return {
    variants: presentImageVariantByteSizes(row),
    storage_label: storageBackendLabel({
      storage_slug: row.storage_slug,
      storage_display_name: storageRecords.get(row.storage_slug)!.display_name
    })
  };
}

function presentImageBase(
  row: ImageMetadataRecord & { tags: string[] },
  storageRecords: ReadonlyMap<string, StorageBackendRecord>
) {
  const base_url = publicImageBaseUrl(storageRecords.get(row.storage_slug)!);
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
    base_url
  };
}

function presentAdminImageBase(
  row: ImageMetadataRecord & ImageVariantByteSizeRecord & { tags: string[] },
  storageRecords: ReadonlyMap<string, StorageBackendRecord>
) {
  const base = presentImageBase(row, storageRecords);
  return {
    ...base,
    ...presentImageAdminStorage(row, storageRecords),
    original: row.original
  };
}

export async function ingestionImageItemsWithTags(rows: IngestionImageRecordWithTags[]) {
  if (!rows.length) return [];
  const storageRecords = await storageRecordsForRows(rows);
  return rows.map((row): CompletedIngestionImageDto => ({
    ...presentImageBase(row, storageRecords),
    storage_slug: row.storage_slug,
    variants: presentImageVariants(row),
    width: Number(row.s_width),
    height: Number(row.s_height),
    original: row.original,
    large_md5: row.l_md5,
    image_time: serializeTimestamp(row.image_time)
  }));
}

function editableImageSnapshot(
  row: EditableImageSnapshotRecordWithTags,
  storageRecords: ReadonlyMap<string, StorageBackendRecord>
): EditableImageSnapshotDto {
  return {
    ...presentAdminImageBase(row, storageRecords),
    width: Number(row.s_width),
    height: Number(row.s_height)
  };
}

export async function adminImageListItemsWithTags(rows: ImageRecordWithTags[]) {
  if (!rows.length) return [];
  const storageRecords = await storageRecordsForRows(rows);
  return rows.map((row): AdminImageListItemDto => ({
    ...editableImageSnapshot(row, storageRecords),
    status: row.status,
    purge_pending: row.purge_pending,
    deleted_at: serializeNullableTimestamp(row.deleted_at),
    image_time: serializeTimestamp(row.image_time),
    ...presentImageAdminTimestamps(row)
  }));
}

export async function adminImageDetailItemsWithTags(rows: AdminImageDetailRecordWithTags[]) {
  if (!rows.length) return [];
  const storageRecords = await storageRecordsForRows(rows);
  return rows.map((row): AdminImageRecentItemDto => ({
    ...presentAdminImageBase(row, storageRecords),
    original: hasOriginal(row),
    image_time: serializeTimestamp(row.image_time),
    ...presentImageAdminTimestamps(row)
  }));
}

export async function editableImageSnapshotsWithTags(rows: EditableImageSnapshotRecordWithTags[]) {
  if (!rows.length) return [];
  const storageRecords = await storageRecordsForRows(rows);
  return rows.map((row) => editableImageSnapshot(row, storageRecords));
}

export async function publicImageDetail(
  row: PublicImageDetailRecord,
  view: PublicImageView,
  access: StorageRegistryAccess,
  includeOriginal = false
): Promise<PublicImageDetailDto<PublicImageView>> {
  const storageRecords = await storageRecordsForRows([row], access);
  const base_url = publicImageBaseUrl(storageRecords.get(row.storage_slug)!);
  return {
    device: row.device,
    author: row.author,
    brightness: row.brightness,
    ...(view === "show" ? { theme: row.theme, tags: row.tags } : {}),
    image_time: serializePublicImageTime(row),
    description: row.description,
    source: row.source || null,
    base_url,
    ...(includeOriginal ? { original: hasOriginal(row) } : {})
  };
}

function publicShowImageCard(
  row: PublicShowImageRecord,
  storageRecords: ReadonlyMap<string, StorageBackendRecord>
): ShowImageCardDto {
  return {
    id: row.id,
    title: row.title,
    base_url: publicImageBaseUrl(storageRecords.get(row.storage_slug)!),
    width: Number(row.width),
    height: Number(row.height)
  };
}

export async function publicShowImageCards(
  rows: PublicShowImageRecord[],
  access: StorageRegistryAccess
) {
  if (!rows.length) return [];
  const storageRecords = await storageRecordsForRows(rows, access);
  return rows.map((row) => publicShowImageCard(row, storageRecords));
}

function publicImageCard(
  row: PublicImageCardRecord,
  tags: string[],
  storageRecords: ReadonlyMap<string, StorageBackendRecord>
): GalleryImageCardDto {
  return {
    ...publicShowImageCard(row, storageRecords),
    theme: row.theme,
    tags
  };
}

export async function publicImageCardsWithTags(
  rows: Array<PublicImageCardRecord & { tags: string[] }>,
  access: StorageRegistryAccess
) {
  if (!rows.length) return [];
  const storageRecords = await storageRecordsForRows(rows, access);
  return rows.map((row) => publicImageCard(row, row.tags, storageRecords));
}
