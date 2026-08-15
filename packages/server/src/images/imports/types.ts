import type {
  Brightness,
  Device,
  ImageDraftDto,
  ImportDuplicateDecision,
  ImportMode,
  ImportSessionCreateDto,
  ImportStatus
} from "@imageshow/shared/browser";
import type { ImageExt } from "../processing.ts";

export type ImportCreateInput = ImportSessionCreateDto;
export type ImportMetadata = ImageDraftDto;

export type MetadataPayload = ImportMetadata & {
  image_time: string;
};

export type ImportDuplicateCheck = {
  md5: string;
  match_count: number;
};

export type ImportDuplicateConfirmation = {
  commit_attempt_id: string;
  expected_md5: string;
  decision: ImportDuplicateDecision;
};

export type PreparedPayload = MetadataPayload & {
  mode: ImportMode;
  source_url: string;
  prepared_image_key: string;
  prepared_thumbnail_key: string;
  original_size: number;
  original_width: number;
  original_height: number;
  width: number;
  height: number;
  ext: ImageExt;
  md5: string;
  prepared_image_sha256?: string;
  prepared_thumbnail_sha256?: string;
  size: number;
  thumbnail_size: number;
  quality: number | null;
  transcoded: boolean;
  detected_device: Device;
  detected_brightness: Brightness;
  duplicate_check: ImportDuplicateCheck;
  duplicate_confirmation?: ImportDuplicateConfirmation;
};

export type ImportSessionRow = {
  id: string;
  mode: ImportMode;
  status: ImportStatus;
  storage_slug: string;
  source_url: string;
  expected_size: string | number | null;
  final_object_key: string;
  execution_token: string | null;
  raw_token: string | null;
  metadata_payload: MetadataPayload;
  prepared_payload: Partial<PreparedPayload>;
  request_hash: string;
  image_time: string | Date;
  error: string;
  expires_at: string | Date;
};
