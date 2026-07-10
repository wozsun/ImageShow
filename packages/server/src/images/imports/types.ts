import type { z } from "zod";
import type { Brightness, Device, ImageExt } from "@imageshow/shared";
import { importCommitInput, importCreateInput } from "../../core/validation.ts";
import type { AdminImage } from "../presenter.ts";

export type ImportCreateInput = z.infer<typeof importCreateInput>;
type ImportCommitInput = z.infer<typeof importCommitInput>;
export type ImportMetadata = ImportCommitInput;
export type ImportMode = "upload" | "download" | "proxy";
export type ImportStatus =
  | "created"
  | "receiving"
  | "preparing"
  | "ready"
  | "committing"
  | "finalized"
  | "failed"
  | "cancelled";

export type MetadataPayload = ImportMetadata & {
  image_time: string;
};

export type PreparedPayload = MetadataPayload & {
  mode: ImportMode;
  source_url: string;
  prepared_thumbnail_key: string;
  original_size: number;
  original_width: number;
  original_height: number;
  width: number;
  height: number;
  ext: ImageExt;
  md5: string;
  size: number;
  thumbnail_size: number;
  quality: number | null;
  transcoded: boolean;
  resolved_device: Device;
  resolved_brightness: Brightness;
};

export type ImportSessionRow = {
  id: string;
  mode: ImportMode;
  status: ImportStatus;
  storage_slug: string;
  source_url: string;
  expected_size: string | number | null;
  final_object_key: string;
  metadata_payload: MetadataPayload;
  prepared_payload: Partial<PreparedPayload>;
  request_hash: string;
  image_time: string | Date;
  error: string;
  expires_at: string | Date;
};

export type PreparedImportResult = {
  id: string;
  mode: ImportMode;
  preview_url: string;
  preview_full_url: string;
  width: number;
  height: number;
  original_width: number;
  original_height: number;
  ext: ImageExt;
  md5: string;
  original_size: number;
  size: number;
  quality: number | null;
  transcoded: boolean;
  device: Device;
  brightness: Brightness;
  storage_slug: string;
  duplicate_exists: boolean;
  duplicates: AdminImage[];
};

export type ImportStatusEvent = {
  id: string;
  status: string;
  error: string;
  phase: string;
  message: string;
};
