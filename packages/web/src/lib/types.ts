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
  ImportItemInputDto,
  ServerIngestionStatusDto,
  StorageBackendAdminDto,
  StorageBackendS3Dto,
  TagDto,
  ThemeDto,
  UploadIntentItemInputDto
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
export type IngestionCommonAttributeField = "device" | "brightness" | "theme" | "author" | "tags";
export type IngestionDetectedClassification = { device: Device; brightness: Brightness };
type CommitFailureCheckpoint = "ready" | "committing" | "unknown";
export type IngestionCommitIntent = {
  attemptId: string;
  md5: string;
  metadata: ImageDraft;
};
type IngestionResultState = "pending" | "recovering" | "error" | "hydrated";

export type IngestionJob = {
  id: string;
  kind: "upload" | "import";
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
  duplicateCount?: number;
  duplicateDecision: "upload" | "undecided" | "confirmed";
  detectedClassification?: IngestionDetectedClassification;
  classificationOverride?: Partial<Record<"device" | "brightness", boolean>>;
  file?: File;
  fileFingerprint?: string;
  md5?: string;
  preparedOrder?: number;
  downloadUrl?: string;
  // 当前前端处理尝试，同时作为 create 请求幂等键；重试时会更新。
  attemptKey: string;
  // 接管请求一旦开始便冻结；响应未知重放必须复用相同幂等键与完全相同的正文。
  uploadIntentItemInput?: UploadIntentItemInputDto;
  importAcceptItemInput?: ImportItemInputDto;
  // 单次入队动作的稳定批次身份；随接管请求发送并用于同批排序。
  batchKey: string;
  // Redis canonical pair；状态读取、提交和取消始终同时携带两部分身份。
  sessionId?: string;
  imageId?: string;
  serverVersion?: number;
  serverProgressSeq?: number;
  serverSemanticRevision?: number;
  // HTTP 接管响应与当前 SSE/snapshot 水位之间的独立围栏。未知水位的
  // completed 重放保持 pending，直到一次新的权威快照接管该 pair。
  serverHandoffPending?: boolean;
  serverHandoffRevision?: number;
  // 响应先于当前有界页时，仅在原占位所在页保留同一张卡；是否计入
  // 客户端临时摘要由 Server 返回的 canonical 新建事实决定。
  serverHandoffDisplayPage?: number;
  serverHandoffProvisionalTotal?: boolean;
  serverAcceptedOrder?: number;
  serverAccepted?: boolean;
  serverDraftPending?: boolean;
  imageTime?: string;
  batchTime?: string;
  manifestSource?: ManifestImportSource;
  manifestProvidedCommonFields?: IngestionCommonAttributeField[];
  manifestLine?: number;
  batchPosition?: number;
  browserDisplayReleased?: boolean;
  originalSize?: number;
  finalSize?: number;
  quality?: number | null;
  transcoded?: boolean;
  storageSlug: string;
  failureStage?: "create" | "prepare" | "commit" | "cancel";
  commitFailureCheckpoint?: CommitFailureCheckpoint;
  commitIntent?: IngestionCommitIntent;
  resultState?: IngestionResultState;
  resultError?: string;
  // 最近一次由当前 attempt/session 接受的服务端权威快照。可见详情由这些
  // 字段和客户端状态集中派生，不直接展示服务端正常阶段 message。
  serverStatus?: ServerIngestionStatusDto | "missing";
  serverPhase?: string;
  serverError?: string;
  serverProgress?: number;
  serverAttemptKey?: string;
  serverSessionId?: string;
  serverImageId?: string;
};
