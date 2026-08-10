import type {
  Dispatch,
  RefObject,
  SetStateAction
} from "react";
import type { SelectOption } from "../../../lib/ui/select-options.js";
import type {
  FacetOption,
  ImageDraft,
  ImageItem,
  ImportJob
} from "../../../lib/types.js";
import type { ImportAttributeDefaults } from "../../../lib/upload/upload-utils.js";
import type { ImportPreviewTarget } from "./DuplicateMatchPanel.js";
import type { JsonlManifestParseError } from "./import-api.js";
import type {
  ImportSourceMode,
  ImportSourceSubmission
} from "./link-import/ImportSourceDialog.js";
import type { UploadCleanupAction } from "./upload-cleanup-actions.js";
import type { ImportQueueController } from "./useImportQueue.js";

type ImportSourceDialogComponent =
  typeof import("./link-import/ImportSourceDialog.js")["ImportSourceDialog"];

export type UploadWorkflowHeaderController = {
  cleanupActions: UploadCleanupAction[];
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  file: {
    inputId: string;
    inputRef: RefObject<HTMLInputElement | null>;
    onAdd: (files: FileList | null) => void;
  };
  source: {
    pending: boolean;
    mode: ImportSourceMode;
    pickerRef: RefObject<HTMLButtonElement | null>;
    onOpen: (mode: ImportSourceMode) => void;
    onPreload: () => void;
  };
};

export type UploadWorkflowDefaultsController = {
  values: ImportAttributeDefaults;
  expanded: boolean;
  summary: string;
  canApply: boolean;
  themes: FacetOption[];
  tags: FacetOption[];
  authors: FacetOption[];
  onChange: Dispatch<SetStateAction<ImportAttributeDefaults>>;
  onExpandedChange: (expanded: boolean) => void;
};

export type UploadWorkflowTasksController = {
  jsonlErrors: JsonlManifestParseError[];
  dragOver: boolean;
  storageName: (slug: string) => string;
  themes: FacetOption[];
  tags: FacetOption[];
  authors: FacetOption[];
  onClearJsonlErrors: () => void;
  onDragOverChange: (dragOver: boolean) => void;
  onAddFiles: (files: FileList | null) => void;
  onPatchJob: (job: ImportJob, patch: Partial<ImageDraft>) => void;
  onCancelJob: (job: ImportJob) => void;
  onRetryJob: (job: ImportJob) => void;
  onRemoveJob: (job: ImportJob) => void;
  onConfirmDuplicateJob: (job: ImportJob) => void;
  onOpenDetail: (item: ImageItem, opener: HTMLElement) => void;
  onOpenPreview: (target: ImportPreviewTarget) => void;
};

export type UploadWorkflowFooterController = {
  activeBackend: string;
  backendOptions: readonly SelectOption[];
  onBackendChange: (backend: string) => void;
  onCancelAll: () => Promise<void>;
  onCommitReady: () => void;
};

type UploadWorkflowOverlaysController = {
  detail: {
    item: ImageItem | null;
    returnFocusRef: RefObject<HTMLElement | null>;
    onClose: () => void;
  };
  preview: {
    target: ImportPreviewTarget | null;
    returnFocusRef: RefObject<HTMLElement | null>;
    onClose: () => void;
  };
  source: {
    open: boolean;
    component: ImportSourceDialogComponent | null;
    mode: ImportSourceMode;
    autoImportAfterParse: boolean;
    maxItems: number;
    weiboMaxItems: number;
    returnFocusRef: RefObject<HTMLElement | null>;
    onClose: () => void;
    onSubmit: (submission: ImportSourceSubmission) => void;
  };
};

/** Stable responsibility map consumed by the upload workflow window. */
export type UploadWorkflowWindowController = {
  mode: "file" | "link";
  busy: boolean;
  queue: ImportQueueController;
  listRef: RefObject<HTMLDivElement | null>;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  header: UploadWorkflowHeaderController;
  defaults: UploadWorkflowDefaultsController;
  tasks: UploadWorkflowTasksController;
  footer: UploadWorkflowFooterController;
  overlays: UploadWorkflowOverlaysController;
};
