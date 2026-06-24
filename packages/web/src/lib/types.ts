export type Device = "pc" | "mb" | "none";
export type Brightness = "dark" | "light" | "none";
export type StorageBackend = "local" | "s3";

export type ImageItem = {
  id: string;
  title: string;
  description: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  status: "ready" | "deleted";
  object_url: string;
  object_key: string;
  storage_backend: StorageBackend;
  thumb_url: string;
  md5: string;
  original: string;
  source: string;
  category_key: string;
  category_index: number;
  index_key: string;
  width: number;
  height: number;
  created_at: string;
  deleted_at?: string;
};

export type ImageDraft = {
  device: Device;
  brightness: Brightness;
  theme: string;
  title: string;
  description: string;
  source: string;
  original: string;
};

export type StorageSettings = {
  backend: "local" | "s3";
  s3: {
    enabled: boolean;
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
};

export type SiteSettings = {
  name: string;
  domain: string;
  icon_url: string;
  root_redirect: "home" | "gallery";
};

export type AdminSettings = {
  storage: StorageSettings;
  site: SiteSettings;
  home: { preview_delay_ms: number };
  upload: { max_file_size_mb: number; presign_expires_seconds?: number; max_long_edge: number; list_page_size: number };
  admin: { image_page_size: number };
  gallery: { default_limit: number };
  random: { default_method: "proxy" | "redirect" };
};

export type SiteConfig = {
  site: SiteSettings;
  home: { preview_delay_ms: number };
  upload: { max_file_size_mb: number; max_long_edge: number };
  image_detail: { title_opens_image: boolean };
};

export type AuthState = {
  authenticated: boolean;
  username: string;
  csrf_token: string;
};

export type GalleryOptions = {
  devices: string[];
  brightnesses: string[];
  themes: string[];
};

export type RandomMode = "" | "redirect" | "proxy";

export type RandomLinkDraft = {
  device: string;
  brightness: string;
  theme: string;
  mode: RandomMode;
};

export type UploadJob = {
  id: string;
  file: File;
  status: "hashing" | "queued" | "uploading" | "finalizing" | "done" | "failed";
  message: string;
  preview: string;
  draft: ImageDraft;
  md5: string;
  width: number;
  height: number;
  uploadProgress: number;
  duplicates: ImageItem[];
  duplicateDecision: "upload" | "undecided";
  detected: { device: Device; brightness: Brightness };
};
