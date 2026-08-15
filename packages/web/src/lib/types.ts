export type {
  AdminSettings,
  Brightness,
  Device,
  SiteSettings
} from "@imageshow/shared/browser";
import type {
  AdminUserDto,
  AdvancedConfigPreviewDto,
  AdminImageDetailItemDto,
  AdminImageListItemDto,
  AuthorDto,
  EditableImageSnapshotDto,
  Brightness,
  Device,
  FacetOptionDto,
  GalleryImageCardDto,
  ImageDetailItemDto,
  ImageDraftDto,
  ImageAdminInfoDto,
  PublicImageItemDto,
  RandomMethod,
  RuntimeConfigChangeSummaryDto,
  StoredImportServerStatus,
  StorageBackendAdminDto,
  StorageBackendS3Dto,
  TagDto,
  ThemeDto
} from "@imageshow/shared/browser";

export type GalleryImageCard = GalleryImageCardDto;
export type ImageDetailItem = ImageDetailItemDto;
export type PublicImageItem = PublicImageItemDto;
export type AdminImageDetailItem = AdminImageDetailItemDto;
export type EditableImageSnapshot = EditableImageSnapshotDto;
/** Editor baseline fields; the server-only Gallery subtitle stays authoritative. */
export type ImageEditorItem = Omit<EditableImageSnapshotDto, "subtitle">;
export type AdminImageListItem = AdminImageListItemDto;
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
export type ImportCommitIntent = {
  attemptId: string;
  createdAt: string;
  metadata: ImageDraft;
};
type ImportResultState = "pending" | "recovering" | "error" | "hydrated";

export type ImportJob = {
  id: string;
  kind: "local" | "download";
  status: "queued" | "uploading" | "downloading" | "received" | "processing" | "ready" | "commit-queued" | "committing" | "finalized" | "cancelling" | "done" | "failed" | "cancelled";
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
  duplicates: AdminImageListItem[];
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
  // 单次入队动作的前端身份；同批任务独立持有稳定状态订阅，绝不发送给服务端。
  subscriptionBatchKey: string;
  // 已成功创建的 import_session id；事件回填、轮询和提交只使用真实会话 id。
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
  commitIntent?: ImportCommitIntent;
  resultState?: ImportResultState;
  resultError?: string;
  // 最近一次由当前 attempt/session 接受的服务端权威快照。可见详情由这些
  // 字段和客户端状态集中派生，不直接展示服务端正常阶段 message。
  serverStatus?: StoredImportServerStatus;
  serverPhase?: string;
  serverError?: string;
  serverProgress?: number;
  serverAttemptKey?: string;
  serverSessionId?: string;
};
