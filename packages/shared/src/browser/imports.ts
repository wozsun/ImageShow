import type { Brightness, Device } from "./common.ts";
import type {
  AdminImageItemDto,
  FacetOptionDto,
  ImageDraftDto
} from "./images.ts";

export const importStatusBatchMaxItems = 100;
export const importModes = ["upload", "download"] as const;
export type ImportMode = (typeof importModes)[number];

export const importStatuses = [
  "created",
  "materializing",
  "received",
  "preparing",
  "ready",
  "committing",
  "finalized",
  "failed",
  "cancelled"
] as const;
export type ImportStatus = (typeof importStatuses)[number];
export type StoredImportServerStatus = ImportStatus | "missing";

export type ImportSessionHandleDto = {
  id: string;
  upload_url?: string;
  materialize_url?: string;
  prepare_url: string;
};

export type ImportSessionCreateDto = ImageDraftDto & {
  mode: ImportMode;
  size?: number;
  source_url?: string;
  image_time?: string;
  batch_time?: string;
  manifest_position?: number;
  idempotency_key: string;
  storage_slug?: string;
};

export type PreparedImportDto = {
  id: string;
  preview_url: string;
  preview_full_url: string;
  width: number;
  height: number;
  original_width: number;
  original_height: number;
  md5: string;
  original_size: number;
  size: number;
  quality: number | null;
  transcoded: boolean;
  detected_device: Device;
  detected_brightness: Brightness;
  storage_slug: string;
  duplicates: AdminImageItemDto[];
};

export type JsonlManifestItemDto = {
  line: number;
  manifest_position: number;
  original: string;
  source?: string;
  image_time?: string;
  author?: string;
  tags?: string[];
  title?: string;
  description?: string;
  theme?: string;
  device?: Device | "auto";
  brightness?: Brightness | "auto";
  storage_slug?: string;
};

export type JsonlManifestParseErrorDto = {
  line: number;
  raw: string;
  error: string;
};

export type JsonlManifestResultDto = {
  items: JsonlManifestItemDto[];
  errors: JsonlManifestParseErrorDto[];
};

export type WeiboImportParseErrorDto = {
  line: number;
  url: string;
  error: string;
};

export type WeiboImportResultDto = {
  post_count: number;
  errors: WeiboImportParseErrorDto[];
  manifest: JsonlManifestResultDto;
};

export type ImportVocabularyDto = {
  themes: FacetOptionDto[];
  tags: FacetOptionDto[];
  authors: FacetOptionDto[];
};

export type StoredImportStatusDto = {
  id: string;
  status: StoredImportServerStatus;
  error: string;
  phase: string;
  message: string;
  progress?: number;
};

export type StoredImportStatusListDto = {
  items: StoredImportStatusDto[];
};

export type StoredImportCommitResultDto = {
  status: "imported";
  item: AdminImageItemDto;
};

export type StoredImportBatchCommitItemInputDto = {
  id: string;
  metadata: ImageDraftDto;
};

export type StoredImportBatchCommitItemResultDto =
  | ({ id: string } & StoredImportCommitResultDto)
  | { id: string; status: "failed"; code: string; message: string };

export type StoredImportBatchCommitResultDto = {
  imported: number;
  failed: number;
  items: StoredImportBatchCommitItemResultDto[];
};
