import { useState, type RefObject } from "react";
import { WorkflowDefaultFields } from "../../../../components/form/WorkflowDefaultFields.js";
import { SelectMenu } from "../../../../components/form/SelectMenu.js";
import { AdminIcon } from "../../../../components/icon/AdminIcon.js";
import { WorkflowCollapsePanel } from "../../../../components/layout/WorkflowCollapsePanel.js";
import { AdminPagination } from "../../../../components/navigation/AdminPagination.js";
import { copyTextToClipboard } from "../../../../lib/ui/clipboard.js";
import { facetDisplayName } from "../../../../lib/ui/formatters.js";
import { preloadIntentProps } from "../../../../lib/ui/preload-intent.js";
import {
  uploadCommonBrightnessOptions,
  uploadCommonDeviceOptions,
  type SelectOption
} from "../../../../lib/ui/select-options.js";
import type {
  AdminImageListItem,
  FacetOption,
  ImageDraft,
  IngestionJob
} from "../../../../lib/types.js";
import type { IngestionAttributeDefaults } from "../queue/model/ingestion-attribute-defaults.js";
import type { IngestionPreviewTarget } from "../queue/cards/DuplicateMatchPanel.js";
import { IngestionJobList } from "../queue/cards/IngestionJobList.js";
import type { ImportManifestParseError } from "../queue/ingestion-api.js";
import type { IngestionQueueController } from "../queue/useIngestionQueue.js";
import type { useIngestionDuplicateDetails } from "../queue/useIngestionDuplicateDetails.js";
import type { ImportSourceMode } from "../import/ImportSourceDialog.js";
import { IngestionCleanupMenu } from "./IngestionCleanupMenu.js";
import type {
  IngestionCleanupAction,
  IngestionCleanupActionId
} from "./ingestion-cleanup-actions.js";

const sourceOptions: Array<[ImportSourceMode, string]> = [
  ["urls", "链接"],
  ["jsonl", "清单"],
  ["weibo", "微博"]
];

export function IngestionWorkflowHeader({
  mode,
  modeTitle,
  emptySubtitle,
  counts,
  cleanup,
  source,
  file,
  closeButtonRef,
  onRequestClose
}: {
  mode: "upload" | "import";
  modeTitle: string;
  emptySubtitle: string;
  counts: Readonly<{
    total: number;
    waiting: number;
    running: number;
    ready: number;
    committing: number;
    done: number;
  }>;
  cleanup: Readonly<{
    actions: IngestionCleanupAction[];
    onSelect: (
      action: IngestionCleanupActionId,
      returnFocusTarget: HTMLElement
    ) => void;
  }>;
  source: Readonly<{
    pending: boolean;
    mode: ImportSourceMode;
    pickerRef: RefObject<HTMLButtonElement | null>;
    onPreload: () => void;
    onOpen: (mode: ImportSourceMode) => void;
  }>;
  file: Readonly<{
    inputId: string;
    inputRef: RefObject<HTMLInputElement | null>;
    onAdd: (files: FileList | null) => void;
  }>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onRequestClose: () => void;
}) {
  return (
    <header className="ingestion-window-header">
      <div className="ingestion-head-copy">
        <h1>{modeTitle}</h1>
        {counts.total > 0 ? (
          <p className="ingestion-task-summary">
            <span className="ingestion-summary-primary">
              共 {counts.total} 张图片，{counts.waiting} 张等待中，
              {counts.running} 张处理中；
            </span>
            <span className="ingestion-summary-secondary">
              {counts.ready} 张待提交，{counts.committing} 张提交中，
              {counts.done} 张已完成
            </span>
          </p>
        ) : (
          <p className="ingestion-empty-subtitle">{emptySubtitle}</p>
        )}
      </div>
      <div className="ingestion-head-actions">
        <div className="ingestion-clear-actions">
          {cleanup.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="clear-button"
              disabled={!action.enabled}
              onClick={(event) => {
                cleanup.onSelect(action.id, event.currentTarget);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
        <div className="ingestion-primary-actions">
          <IngestionCleanupMenu
            actions={cleanup.actions}
            onSelect={cleanup.onSelect}
          />
          {mode === "import" ? (
            <div
              className={`ingestion-source-picker${
                source.pending ? " is-disabled" : ""
              }`}
              role="group"
              aria-label="选择导入来源"
              aria-disabled={source.pending}
            >
              {sourceOptions.map(([sourceMode, label]) => (
                <button
                  key={sourceMode}
                  ref={source.mode === sourceMode ? source.pickerRef : undefined}
                  type="button"
                  className="ingestion-source-option pressable"
                  disabled={source.pending}
                  {...preloadIntentProps(source.onPreload)}
                  onClick={() => source.onOpen(sourceMode)}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <label className="button secondary upload-picker pressable">
              <AdminIcon name="upload-cloud-2-line" />
              <input
                id={file.inputId}
                ref={file.inputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={(event) => {
                  file.onAdd(event.target.files);
                  event.target.value = "";
                }}
              />
              选择图片
            </label>
          )}
          <button
            ref={closeButtonRef}
            className="icon close pressable ingestion-close-button"
            type="button"
            title="关闭"
            onClick={onRequestClose}
          >
            <AdminIcon name="close-line" />
          </button>
        </div>
      </div>
    </header>
  );
}

export function IngestionWorkflowDefaults({
  defaults,
  expanded,
  onExpandedChange,
  onChange,
  themes,
  tags,
  authors,
  applyDisabled,
  onApply
}: {
  defaults: IngestionAttributeDefaults;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onChange: (defaults: IngestionAttributeDefaults) => void;
  themes: FacetOption[];
  tags: FacetOption[];
  authors: FacetOption[];
  applyDisabled: boolean;
  onApply: () => void;
}) {
  const summary = [
    uploadCommonDeviceOptions.find(
      (option) => option.value === defaults.device
    )?.label ?? "设备不设",
    uploadCommonBrightnessOptions.find(
      (option) => option.value === defaults.brightness
    )?.label ?? "亮暗不设",
    facetDisplayName(themes, defaults.theme, "主题不设"),
    facetDisplayName(authors, defaults.author, "作者不设"),
    `${defaults.tags.length} 个标签`
  ].join(" · ");

  return (
    <WorkflowCollapsePanel
      className="ingestion-defaults-panel"
      contentClassName="ingestion-defaults workflow-defaults"
      title="默认属性"
      summary={summary}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    >
      <WorkflowDefaultFields
        values={defaults}
        onChange={{
          device: (device) => onChange({
            ...defaults,
            device: device as IngestionAttributeDefaults["device"]
          }),
          brightness: (brightness) => onChange({
            ...defaults,
            brightness: brightness as IngestionAttributeDefaults["brightness"]
          }),
          theme: (theme) => onChange({ ...defaults, theme }),
          author: (author) => onChange({ ...defaults, author }),
          tags: (nextTags) => onChange({ ...defaults, tags: nextTags })
        }}
        deviceOptions={uploadCommonDeviceOptions}
        brightnessOptions={uploadCommonBrightnessOptions}
        themes={themes}
        authors={authors}
        tags={tags}
        placeholders={{
          theme: "主题",
          author: "默认作者",
          tags: "默认标签"
        }}
        ariaLabels={{
          device: "默认设备",
          brightness: "默认亮度",
          theme: "默认主题",
          author: "默认作者",
          tags: "默认标签"
        }}
        applyDisabled={applyDisabled}
        onApply={onApply}
      />
    </WorkflowCollapsePanel>
  );
}

type DuplicateDetailsController = ReturnType<typeof useIngestionDuplicateDetails>;

export function IngestionWorkflowQueueBody({
  listRef,
  mode,
  busy,
  queue,
  duplicateDetails,
  importParseErrors,
  onClearImportParseErrors,
  storageName,
  vocabulary,
  jobActions,
  fileInputRef,
  source
}: {
  listRef: RefObject<HTMLDivElement | null>;
  mode: "upload" | "import";
  busy: boolean;
  queue: IngestionQueueController;
  duplicateDetails: DuplicateDetailsController;
  importParseErrors: ImportManifestParseError[];
  onClearImportParseErrors: () => void;
  storageName: (slug: string) => string;
  vocabulary: Readonly<{
    themes: FacetOption[];
    tags: FacetOption[];
    authors: FacetOption[];
  }>;
  jobActions: Readonly<{
    onPatch: (job: IngestionJob, patch: Partial<ImageDraft>) => void;
    onCancel: (job: IngestionJob) => void;
    onRetry: (job: IngestionJob) => void;
    onRemove: (job: IngestionJob) => void;
    onConfirmDuplicate: (job: IngestionJob) => void;
    onOpenDetail: (
      job: IngestionJob,
      item: AdminImageListItem,
      opener: HTMLElement
    ) => void;
    onFocusWithin: (
      job: IngestionJob,
      card: HTMLElement,
      target: HTMLElement
    ) => void;
    onPreview: (target: IngestionPreviewTarget) => void;
  }>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  source: Readonly<{
    pending: boolean;
    onPreload: () => void;
    onOpen: (mode: ImportSourceMode) => void;
    onAddFiles: (files: FileList | null) => void;
  }>;
}) {
  const [dragOver, setDragOver] = useState(false);
  const serverReady = queue.server.status === "ready";
  const serverFailed = queue.server.status === "error";

  return (
    <div
      className="modal-scroll-list image-workflow-list ingestion-list"
      ref={listRef}
    >
      {importParseErrors.length > 0 && (
        <div className="ingestion-queue-notice">
          <span>{importParseErrors.length} 行未创建任务</span>
          <button
            type="button"
            onClick={() => void copyTextToClipboard(
              importParseErrors
                .map((error) => (
                  `第 ${error.line} 行：${error.error}\n${error.raw}`
                ))
                .join("\n\n")
            ).catch(() => undefined)}
          >
            <AdminIcon name="file-copy-line" />复制错误
          </button>
          <button type="button" onClick={onClearImportParseErrors}>
            清除
          </button>
        </div>
      )}
      {queue.serverNotice && (
        <div className="ingestion-queue-notice" role="status">
          <span>{queue.serverNotice}</span>
          {queue.serverNoticeRetryable && (
            <button type="button" onClick={queue.retryServerNotice}>
              <AdminIcon name="refresh-line" />重试
            </button>
          )}
        </div>
      )}
      {queue.actions.notice && (
        <div className="ingestion-queue-notice" role="status">
          <span>{queue.actions.notice}</span>
        </div>
      )}
      {duplicateDetails.error && (
        <div className="ingestion-queue-notice" role="alert">
          <span>{duplicateDetails.error}</span>
          <button type="button" onClick={duplicateDetails.refresh}>
            <AdminIcon name="refresh-line" />重试
          </button>
        </div>
      )}
      {serverFailed && (
        <div className="ingestion-queue-notice" role="alert">
          <span>{queue.server.error || "服务端队列读取失败"}</span>
          <button type="button" onClick={queue.server.refresh}>
            <AdminIcon name="refresh-line" />重试
          </button>
        </div>
      )}
      <IngestionJobList
        jobs={queue.visibleJobs}
        busy={busy}
        storageName={storageName}
        themes={vocabulary.themes}
        tags={vocabulary.tags}
        authors={vocabulary.authors}
        onPatch={jobActions.onPatch}
        onCancel={jobActions.onCancel}
        onRetry={jobActions.onRetry}
        onRemove={jobActions.onRemove}
        onConfirmDuplicate={jobActions.onConfirmDuplicate}
        onOpenDetail={jobActions.onOpenDetail}
        onFocusWithin={jobActions.onFocusWithin}
        onPreview={jobActions.onPreview}
      />
      {serverReady && queue.totalItems === 0 && (mode === "import" ? (
        <button
          type="button"
          className="ingestion-empty-state upload-dropzone"
          disabled={source.pending}
          {...preloadIntentProps(source.onPreload)}
          onClick={() => source.onOpen("urls")}
        >
          <AdminIcon name="download-cloud-2-line" />
          <span>还没有上传或导入任务，点击此处选择图片来源</span>
        </button>
      ) : (
        <button
          type="button"
          className={`ingestion-empty-state upload-dropzone${
            dragOver ? " is-dragover" : ""
          }`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            source.onAddFiles(event.dataTransfer.files);
          }}
        >
          <AdminIcon name="image-line" />
          <span>还没有选择图片，点击此处选择，或将图片拖到这里</span>
        </button>
      ))}
    </div>
  );
}

export function IngestionWorkflowFooter({
  queue,
  backend,
  clear,
  commit
}: {
  queue: IngestionQueueController;
  backend: Readonly<{
    value: string;
    options: readonly SelectOption[];
    onChange: (backend: string) => void;
  }>;
  clear: Readonly<{
    targetRef: RefObject<HTMLButtonElement | null>;
    dangerous: boolean;
    armed: boolean;
    ariaLabel: string;
    onBlur: () => void;
    onClick: () => void;
  }>;
  commit: Readonly<{
    count: number;
    pending: boolean;
    onClick: () => void;
  }>;
}) {
  return (
    <footer
      className={`image-workflow-footer${
        queue.totalPages > 1 ? " has-pagination" : ""
      }`}
    >
      <div className="ingestion-footer-left image-workflow-leading-actions">
        <div className="ingestion-backend">
          <SelectMenu
            className="is-storage-select"
            value={backend.value}
            onChange={backend.onChange}
            options={backend.options}
            ariaLabel="新任务存储位置"
          />
        </div>
      </div>
      {queue.totalPages > 1 && (
        <AdminPagination
          className="image-workflow-pagination"
          ariaLabel="内容接入任务列表分页"
          page={queue.page}
          totalPages={queue.totalPages}
          onPageChange={queue.setPage}
        />
      )}
      <div className="modal-footer-actions">
        <button
          ref={clear.targetRef}
          type="button"
          className={[
            "ingestion-queue-clear-button",
            clear.dangerous ? "danger-button" : "",
            clear.armed ? "is-armed" : ""
          ].filter(Boolean).join(" ")}
          aria-label={clear.ariaLabel}
          aria-pressed={clear.armed}
          onBlur={clear.onBlur}
          onClick={clear.onClick}
        >
          {clear.armed ? "清空" : "取消"}
        </button>
        <button
          className="button workflow-submit-button"
          type="button"
          disabled={!commit.count || commit.pending}
          onClick={commit.onClick}
        >
          {commit.count ? `提交 ${commit.count} 张` : "提交"}
        </button>
      </div>
    </footer>
  );
}
