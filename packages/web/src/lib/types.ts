export type Device = "pc" | "mb";
export type Brightness = "dark" | "light";
export type StorageType = "local" | "s3" | "webdav";

export type ImageItem = {
  id: string;
  title: string;
  description: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  author: string;
  status: "ready" | "deleted";
  object_url: string;
  object_key: string;
  storage_slug: string;
  is_link: boolean;
  thumb_url: string;
  md5: string;
  original: string;
  source: string;
  category_index: number;
  index_key: string;
  width: number;
  height: number;
  tags: string[];
  created_at: string;
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
  device: Device;
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

export type SiteSettings = {
  name: string;
  domain: string;
  icon_url: string;
  root_redirect: "home" | "gallery";
  home: {
    enabled: boolean;
    tagline: string;
    hero_background: string;
    preview_delay_ms: number;
  };
  gallery: { default_limit: number; order: GalleryOrder };
  random_default_method: "proxy" | "redirect";
};

type GalleryOrder = "latest" | "random";

export type AdminSettings = {
  site: SiteSettings;
  upload: {
    max_file_size_mb: number;
    max_long_edge: number;
    list_page_size: number;
    concurrency: number;
  };
  normalize: {
    quality: number;
    quality_step: number;
    min_quality: number;
    max_long_edge: number;
    max_size_kb: number;
    skip_webp_under_kb: number;
  };
  thumbnail: { long_edge: number; quality: number };
  image_detail: { title_opens_image: boolean };
  admin: {
    login_background: string;
    image_page_size: number;
    recent_uploads: number;
    show_unset_theme_card: boolean;
  };
  link_image: {
    fill_original_url: boolean;
    concurrency: number;
  };
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
  detected: { device: Device; brightness: Brightness | "auto" };
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
