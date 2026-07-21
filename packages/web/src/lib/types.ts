export type { AdminSettings, Brightness, Device, SiteSettings, StorageType } from "@imageshow/shared";
import type {
  AdminImageItemDto,
  AdminRole,
  Brightness,
  Device,
  FacetOptionDto,
  GalleryImageCardDto,
  ImageAdminInfoDto,
  PublicImageDetailDto,
  PublicImageItemDto
} from "@imageshow/shared";

export type GalleryImageCard = GalleryImageCardDto;
export type PublicImageDetail = PublicImageDetailDto;
export type PublicImageItem = PublicImageItemDto;
export type ImageItem = AdminImageItemDto;
export type ImageAdminInfo = ImageAdminInfoDto;

export type Tag = {
  slug: string;
  display_name: string;
  image_count: number;
};

export type Theme = {
  slug: string;
  display_name: string;
  image_count: number;
};

export type Author = {
  slug: string;
  display_name: string;
  link: string;
  image_count: number;
};

export type ImageDraft = {
  device: Device | "auto";
  brightness: Brightness | "auto";
  theme: string;
  author: string;
  title: string;
  description: string;
  source: string;
  original: string;
  tags: string[];
};

export type S3Settings = {
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  force_path_style: boolean;
  root_path: string;
  public_base_url: string;
  secret_access_key?: string;
  secret_access_key_configured?: boolean;
};

export type WebdavSettings = {
  base_url: string;
  username: string;
  root_path: string;
  public_base_url: string;
  list_depth_infinity: boolean;
  connect_timeout_seconds: number;
  idle_timeout_seconds: number;
  task_timeout_seconds: number;
  password?: string;
  password_configured?: boolean;
};

type StorageBackendAdminBase = {
  slug: string;
  display_name: string;
  enabled: boolean;
  is_default: boolean;
  image_count: number;
  import_session_count: number;
  cleanup_job_count: number;
  failed_cleanup_job_count: number;
  exhausted_cleanup_job_count: number;
};

export type StorageBackendAdmin = StorageBackendAdminBase & (
  | { type: "local" }
  | { type: "s3"; s3: S3Settings }
  | { type: "webdav"; webdav: WebdavSettings }
);

type AdvancedConfigBackendPreview = {
  slug: string;
  display_name: string;
  type: "s3" | "webdav";
  enabled: boolean;
  is_default: boolean;
};

export type AdvancedConfigPreview = {
  format: "imageshow-config";
  format_version: number;
  application_version: string;
  exported_at: string;
  config_groups: number;
  storage_backends: AdvancedConfigBackendPreview[];
  conflicts: string[];
  existing_slugs: string[];
};

export type RuntimeConfigChangeSummary = {
  access_changes: Array<"site.domain">;
};

export type AdminUser = {
  username: string;
  role: AdminRole;
};

export type FacetOption = FacetOptionDto;

export type RandomMode = "" | "redirect" | "proxy";

export type RandomLinkDraft = {
  device: string;
  brightness: string;
  theme: string;
  tag: string;
  author: string;
  mode: RandomMode;
};

export type ManifestImportSource = "jsonl" | "weibo";
export type ImportCommonAttributeField = "device" | "brightness" | "theme" | "author" | "tags";
export type ImportDetectedClassification = { device: Device; brightness: Brightness };
export type CommitFailureCheckpoint = "ready" | "committing" | "unknown";

export type BatchDuplicateMatch = {
  ownerId: string | null;
  manifestSource?: ManifestImportSource;
  manifestLine?: number;
  manifestPosition?: number;
  original: string;
  preview: string;
  previewFull: string;
  width: number;
  height: number;
  device: ImageDraft["device"];
  brightness: ImageDraft["brightness"];
  theme: string;
  available: boolean;
};

export type ImportJob = {
  id: string;
  kind: "local" | "download";
  status: "queued" | "uploading" | "downloading" | "processing" | "ready" | "committing" | "cancelling" | "done" | "skipped" | "failed" | "cancelled";
  message: string;
  preview: string;
  previewFull?: string;
  objectUrl?: string;
  draft: ImageDraft;
  width: number;
  height: number;
  originalWidth?: number;
  originalHeight?: number;
  transferProgress?: number;
  duplicates: ImageItem[];
  duplicateDecision: "upload" | "undecided";
  detectedClassification?: ImportDetectedClassification;
  classificationOverride?: Partial<Record<"device" | "brightness", boolean>>;
  file?: File;
  fileFingerprint?: string;
  md5?: string;
  url?: string;
  // 当前前端处理尝试，同时作为 create 请求幂等键；重试时会更新。
  attemptKey: string;
  // 已成功创建的 import_session id；SSE 状态监听和提交只使用真实会话 id。
  sessionId?: string;
  imageTime?: string;
  batchTime?: string;
  manifestSource?: ManifestImportSource;
  manifestProvidedCommonFields?: ImportCommonAttributeField[];
  manifestLine?: number;
  manifestPosition?: number;
  duplicatePolicy?: "confirm" | "skip";
  batchDuplicate?: BatchDuplicateMatch;
  originalSize?: number;
  finalSize?: number;
  quality?: number | null;
  transcoded?: boolean;
  storageSlug: string;
  failureStage?: "create" | "prepare" | "commit" | "cancel";
  commitFailureCheckpoint?: CommitFailureCheckpoint;
};
