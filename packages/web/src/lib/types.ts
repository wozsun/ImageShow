export type { AdminSettings, Brightness, Device, SiteSettings, StorageType } from "@imageshow/shared";
import type { Brightness, Device, StorageType } from "@imageshow/shared";

export type GalleryImageCard = {
  id: string;
  title: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  author: string;
  thumb_url: string;
  width: number;
  height: number;
  tags: string[];
  diff_original: boolean;
  image_time: string;
};

export type PublicImageDetail = {
  id: string;
  description: string;
  object_url: string;
  source: string;
};

export type PublicImageItem = GalleryImageCard & PublicImageDetail;

export type ImageItem = PublicImageItem & {
  status: "ready" | "deleted";
  object_key: string;
  storage_slug: string;
  is_link: boolean;
  md5: string;
  original: string;
  extra?: Record<string, unknown>;
  image_size?: number;
  deleted_at?: string;
  created_at?: string;
  updated_at?: string;
};

export type ImageAdminInfo = {
  id: string;
  md5: string;
  storage_label: string;
  image_time: string;
  created_at: string;
  updated_at: string;
};

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
  password?: string;
  password_configured?: boolean;
};

export type StorageBackendAdmin = {
  slug: string;
  display_name: string;
  type: StorageType;
  enabled: boolean;
  is_default: boolean;
  s3: S3Settings;
  webdav: WebdavSettings;
};

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
  restart_required: Array<"port" | "database" | "redis">;
  access_changes: Array<"site.domain">;
};

type AdminRole = "super" | "image";

export type AdminUser = {
  username: string;
  role: AdminRole;
  created_at: string | null;
};

export type FacetOption = {
  slug: string;
  display_name: string;
};

export type RandomMode = "" | "redirect" | "proxy";

export type RandomLinkDraft = {
  device: string;
  brightness: string;
  theme: string;
  tag: string;
  author: string;
  mode: RandomMode;
};

export type BatchDuplicateMatch = {
  ownerId: string | null;
  manifestLine?: number;
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
  kind: "local" | "download" | "proxy";
  status: "queued" | "uploading" | "downloading" | "processing" | "ready" | "committing" | "done" | "skipped" | "failed" | "cancelled";
  message: string;
  preview: string;
  previewFull?: string;
  objectUrl?: string;
  draft: ImageDraft;
  width: number;
  height: number;
  originalWidth?: number;
  originalHeight?: number;
  uploadProgress: number;
  duplicates: ImageItem[];
  duplicateDecision: "upload" | "undecided";
  resolvedClassification?: { device: Device; brightness: Brightness };
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
  manifestLine?: number;
  manifestPosition?: number;
  duplicatePolicy?: "confirm" | "skip";
  batchDuplicate?: BatchDuplicateMatch;
  inlineMetadataFields?: Array<keyof ImageDraft>;
  originalSize?: number;
  finalSize?: number;
  quality?: number | null;
  transcoded?: boolean;
  storageSlug: string;
  failureStage?: "prepare" | "commit";
};
