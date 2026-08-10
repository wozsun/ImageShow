export type {
  AdminSettings,
  Brightness,
  Device,
  SiteSettings,
  StorageType
} from "@imageshow/shared/browser";
import type {
  AdminUserDto,
  AdvancedConfigPreviewDto,
  AdminImageDetailItemDto,
  AdminImageItemDto,
  AuthorDto,
  EditableImageSnapshotDto,
  Brightness,
  Device,
  FacetOptionDto,
  GalleryImageCardDto,
  ImageDraftDto,
  ImageAdminInfoDto,
  PublicImageItemDto,
  RandomMethod,
  RuntimeConfigChangeSummaryDto,
  StorageBackendAdminDto,
  StorageBackendS3Dto,
  StorageBackendWebdavDto,
  TagDto,
  ThemeDto
} from "@imageshow/shared/browser";

export type GalleryImageCard = GalleryImageCardDto;
export type PublicImageItem = PublicImageItemDto;
export type AdminImageDetailItem = AdminImageDetailItemDto;
export type EditableImageSnapshot = EditableImageSnapshotDto;
export type ImageItem = AdminImageItemDto;
export type ImageAdminInfo = ImageAdminInfoDto;

export type Tag = TagDto;
export type Theme = ThemeDto;
export type Author = AuthorDto;
export type ImageDraft = ImageDraftDto;

// 写入表单中的秘密只存在于 Web 页面和提交请求；共享 DTO 只描述服务端已脱敏的读取结果。
export type S3Settings = Omit<
  StorageBackendS3Dto,
  "secret_access_key_configured"
> & {
  secret_access_key?: string;
  secret_access_key_configured?: boolean;
};
export type WebdavSettings = Omit<
  StorageBackendWebdavDto,
  "password_configured"
> & {
  password?: string;
  password_configured?: boolean;
};

export type StorageBackendAdmin = StorageBackendAdminDto;
export type AdvancedConfigPreview = AdvancedConfigPreviewDto;
export type RuntimeConfigChangeSummary = RuntimeConfigChangeSummaryDto;
export type AdminUser = AdminUserDto;

export type FacetOption = FacetOptionDto;

export type RandomMode = "" | RandomMethod;

export type ManifestImportSource = "jsonl" | "weibo";
export type ImportCommonAttributeField = "device" | "brightness" | "theme" | "author" | "tags";
export type ImportDetectedClassification = { device: Device; brightness: Brightness };
export type CommitFailureCheckpoint = "ready" | "committing" | "unknown";

export type ImportJob = {
  id: string;
  kind: "local" | "download";
  status: "queued" | "uploading" | "downloading" | "received" | "processing" | "ready" | "committing" | "cancelling" | "done" | "failed" | "cancelled";
  message: string;
  preview: string;
  previewFallback?: string;
  previewFull?: string;
  objectUrl?: string;
  draft: ImageDraft;
  width: number;
  height: number;
  originalWidth?: number;
  originalHeight?: number;
  transferProgress?: number;
  duplicates: ImageItem[];
  duplicateDecision: "upload" | "undecided" | "confirmed";
  detectedClassification?: ImportDetectedClassification;
  classificationOverride?: Partial<Record<"device" | "brightness", boolean>>;
  file?: File;
  fileFingerprint?: string;
  md5?: string;
  preparedOrder?: number;
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
  originalSize?: number;
  finalSize?: number;
  quality?: number | null;
  transcoded?: boolean;
  storageSlug: string;
  failureStage?: "create" | "prepare" | "commit" | "cancel";
  commitFailureCheckpoint?: CommitFailureCheckpoint;
};
