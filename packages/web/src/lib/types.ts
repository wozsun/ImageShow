export type { AdminSettings, Brightness, Device, SiteSettings, StorageType } from "@imageshow/shared";
import type { Brightness, Device, StorageType } from "@imageshow/shared";

export type GalleryImageCard = {
  id: string;
  title: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  thumb_url: string;
  width: number;
  height: number;
  tags: string[];
  created_at: string;
};

export type ImageItem = GalleryImageCard & {
  description: string;
  author: string;
  status: "ready" | "deleted";
  object_url: string;
  object_key: string;
  storage_slug: string;
  is_link: boolean;
  md5: string;
  original: string;
  extra?: Record<string, unknown>;
  has_distinct_original: boolean;
  source: string;
  image_size?: number;
  deleted_at?: string;
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

export type ImportJob = {
  id: string;
  kind: "local" | "download" | "proxy";
  status: "queued" | "uploading" | "downloading" | "processing" | "ready" | "committing" | "done" | "failed" | "cancelled";
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
  stagingId?: string;
  originalSize?: number;
  finalSize?: number;
  quality?: number | null;
  transcoded?: boolean;
  storageSlug: string;
  failureStage?: "prepare" | "commit";
};
