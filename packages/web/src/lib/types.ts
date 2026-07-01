export type Device = "pc" | "mb";
export type Brightness = "dark" | "light";
// A storage backend's driver kind: 'local' is the built-in; 's3' and 'webdav' are user-creatable.
export type StorageType = "local" | "s3" | "webdav";

export type ImageItem = {
  id: string;
  title: string;
  description: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  // Optional author slug ("" when unset); resolved to a display name + link via the
  // gallery facets, like theme.
  author: string;
  status: "ready" | "deleted";
  object_url: string;
  object_key: string;
  // The named backend this image's bytes live in (storage_backend.slug). is_link =
  // imported external URL (object_key is the URL; only the thumbnail is hosted).
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

// Tags and themes share one shape (slug PK + display name); only cardinality
// differs — an image has many tags but a single theme.
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

// An author mirrors a theme (slug + display name + image count) with one extra field:
// link, an optional http(s) URL for the author's page.
export type Author = {
  slug: string;
  display_name: string;
  link: string;
  image_count: number;
};

export type ImageDraft = {
  device: Device;
  // The editable brightness also carries the transient "auto" (detect/re-detect on the
  // server); the stored value is always a concrete Brightness.
  brightness: Brightness | "auto";
  theme: string;
  // Optional author slug; "" means no author.
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

// A named storage backend as the admin manages it (secrets stripped to flags).
export type StorageBackendAdmin = {
  slug: string;
  display_name: string;
  type: StorageType;
  enabled: boolean;
  is_default: boolean;
  s3: S3Settings;
  webdav: WebdavSettings;
};

// Lightweight selectable backend for upload/migrate target pickers.
export type StorageBackendOption = {
  slug: string;
  display_name: string;
  type: StorageType;
  // Whether new images may be written here; gates only the upload/link selector.
  enabled: boolean;
  is_default: boolean;
};

export type SiteSettings = {
  name: string;
  domain: string;
  icon_url: string;
  root_redirect: "home" | "gallery";
  // Whether the public homepage exists. Only present in SiteConfig (/api/site-config);
  // the admin settings endpoint omits it (file-only), so it's optional. Absent ⇒ enabled.
  home_enabled?: boolean;
  // Admin login background. In AdminSettings this is the raw stored value (empty =
  // auto); in SiteConfig (from /api/site-config) it's the resolved effective URL.
  login_background: string;
  // Homepage hero background. Same raw/effective duality as login_background.
  home_hero_background: string;
};

type GalleryOrder = "latest" | "random";

export type AdminSettings = {
  site: SiteSettings;
  home: { preview_delay_ms: number };
  upload: { max_file_size_mb: number; max_long_edge: number; list_page_size: number; concurrency: number };
  admin: { image_page_size: number; recent_uploads: number; show_unset_theme_card: boolean };
  gallery: { default_limit: number; order: GalleryOrder };
  random: { default_method: "proxy" | "redirect" };
  image_detail: { title_opens_image: boolean };
  // File-only flag read by the uploader: pre-fill 原图URL with the imported link (default off).
  link_image: { fill_original_url: boolean };
};

export type SiteConfig = {
  site: SiteSettings;
  home: { preview_delay_ms: number };
  upload: { max_file_size_mb: number; max_long_edge: number };
  gallery: { order: GalleryOrder };
  image_detail: { title_opens_image: boolean };
  captcha: { enabled: boolean };
};

type AdminRole = "super" | "image";

export type AuthState = {
  authenticated: boolean;
  username: string;
  role: AdminRole | "";
  csrf_token: string;
};

export type AdminUser = {
  username: string;
  role: AdminRole;
  created_at: string | null;
};

// A selectable facet value (theme or tag): canonical slug + human display name.
// The display name is shown/searched; the slug is what goes into URLs.
export type FacetOption = {
  slug: string;
  display_name: string;
};

// An author facet adds a link to the shared facet shape; the detail view links to it.
type AuthorOption = FacetOption & { link: string };

export type GalleryOptions = {
  devices: string[];
  brightnesses: string[];
  themes: FacetOption[];
  tags: FacetOption[];
  authors: AuthorOption[];
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

export type UploadJob = {
  id: string;
  // "file" = a picked file uploaded via the staging session; "link" = an external URL whose
  // thumbnail is staged server-side and committed on submit. file/md5 are set for file jobs,
  // url/stagingId for link jobs.
  kind: "file" | "link";
  status: "hashing" | "queued" | "uploading" | "finalizing" | "done" | "failed";
  message: string;
  preview: string;
  draft: ImageDraft;
  width: number;
  height: number;
  uploadProgress: number;
  duplicates: ImageItem[];
  duplicateDecision: "upload" | "undecided";
  detected: { device: Device; brightness: Brightness | "auto" };
  file?: File;
  md5?: string;
  url?: string;
  stagingId?: string;
};
