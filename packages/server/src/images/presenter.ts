import {
  adminApiBasePath,
  type AdminImageDetailItemDto,
  type AdminImageListItemDto,
  type Brightness,
  type Device,
  type EditableImageSnapshotDto,
  type GalleryImageCardDto,
  type ImportMode,
  type ImportSessionHandleDto,
  type PublicImageDetailDto
} from "@imageshow/shared/browser";
import type { DatabaseReader } from "../core/database-pools.ts";
import type {
  PublicDatabaseReadAccess
} from "../core/public-db-fallback.ts";
import { listStorageBackends } from "../storage/backend-registry.ts";
import { publicImageUrls } from "../storage/public-urls.ts";
import { getTagsForImages } from "../tags/query.ts";
import { hasDistinctOriginalUrl } from "./original-link.ts";

type DatabaseNumber = number | string;
type DatabaseTimestamp = string | Date;

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
  image_time: DatabaseTimestamp;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
};

export type ImageRecordWithTags = ImageRecord & { tags: string[] };

/** Exact row returned by the compact overview detail projection. */
export type AdminImageDetailRecordWithTags = AdminImageCommonRecord & {
  md5: string;
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
 * Columns required by the full admin list, duplicate results and import
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

export type ImportSessionRecord = {
  id: string;
  mode: ImportMode;
};

export function importSessionResponse(
  row: ImportSessionRecord
): ImportSessionHandleDto {
  return {
    id: row.id,
    upload_url: row.mode === "upload"
      ? `${adminApiBasePath}/imports/${row.id}/file`
      : undefined,
    materialize_url: row.mode === "download"
      ? `${adminApiBasePath}/imports/${row.id}/materialize`
      : undefined,
    prepare_url: `${adminApiBasePath}/imports/${row.id}/prepare`
  };
}

async function publicUrlsForRow(
  row: PublicImageUrlRecord,
  access: PublicDatabaseReadAccess = {}
) {
  const storageSlug = row.storage_slug;
  const urls = await publicImageUrls(row.object_key, storageSlug, access);
  return { storageSlug, urls };
}

function serializeTimestamp(value: DatabaseTimestamp) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function serializeNullableTimestamp(value: DatabaseTimestamp | null) {
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
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
  tags?: string[]
): Promise<AdminImageListItemDto> {
  const tagList = tags ?? (await getTagsForImages([row.id])).get(row.id) ?? [];
  const base = await presentAdminImageBase(row, tagList);
  return {
    ...base,
    original: row.original,
    diff_original: hasDistinctOriginalUrl(row.original, base.object_url),
    status: row.status,
    object_key: row.object_key,
    md5: row.md5,
    image_size: Number(row.image_size),
    deleted_at: serializeNullableTimestamp(row.deleted_at),
    image_time: serializeTimestamp(row.image_time),
    created_at: serializeTimestamp(row.created_at),
    updated_at: serializeTimestamp(row.updated_at)
  };
}

export function importCommitImage(row: ImageRecord) {
  return adminImageListItem(row);
}

export async function adminImageListItems(rows: ImageRecord[]) {
  const tagMap = await getTagsForImages(rows.map((row) => row.id));
  return Promise.all(rows.map((row) => adminImageListItem(
    row,
    tagMap.get(row.id) ?? []
  )));
}

export function adminImageListItemsWithTags(rows: ImageRecordWithTags[]) {
  return Promise.all(rows.map((row) => adminImageListItem(row, row.tags)));
}

export function adminImageDetailItemsWithTags(
  rows: AdminImageDetailRecordWithTags[]
) {
  return Promise.all(rows.map(async (row): Promise<AdminImageDetailItemDto> => {
    const base = await presentAdminImageBase(row, row.tags);
    return {
      ...base,
      diff_original: hasDistinctOriginalUrl(row.original, base.object_url),
      md5: row.md5,
      image_time: serializeTimestamp(row.image_time),
      created_at: serializeTimestamp(row.created_at),
      updated_at: serializeTimestamp(row.updated_at)
    };
  }));
}

export function editableImageSnapshotsWithTags(
  rows: EditableImageSnapshotRecordWithTags[]
) {
  return Promise.all(rows.map(async (row): Promise<EditableImageSnapshotDto> => {
    const base = await presentAdminImageBase(row, row.tags);
    return {
      ...base,
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
  tags: string[] = [],
  access: PublicDatabaseReadAccess = {}
): Promise<GalleryImageCardDto> {
  const { urls } = await publicUrlsForRow(row, access);
  const original = row.original;
  return {
    id: row.id,
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
  const database = { reader };
  const tagMap = await getTagsForImages(rows.map((row) => row.id), reader);
  if (rows.length) await listStorageBackends(database);
  return Promise.all(rows.map((row) => publicImageCard(
    row,
    tagMap.get(row.id) ?? [],
    database
  )));
}

export function publicImageCardsWithTags(
  rows: Array<PublicImageCardRecord & { tags: string[] }>,
  access: PublicDatabaseReadAccess = {}
) {
  return (async () => {
    if (rows.length) await listStorageBackends(access);
    return Promise.all(rows.map((row) => publicImageCard(
      row,
      row.tags,
      access
    )));
  })();
}
