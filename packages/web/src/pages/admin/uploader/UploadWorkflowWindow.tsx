import type {
  AnimationEventHandler,
  Dispatch,
  RefObject,
  SetStateAction
} from "react";
import { StableButtonLabel } from "../../../components/data-display/StableButtonLabel.js";
import { AuthorInput } from "../../../components/form/AuthorInput.js";
import { SelectMenu } from "../../../components/form/SelectMenu.js";
import { TagInput } from "../../../components/form/TagInput.js";
import { ThemeInput } from "../../../components/form/ThemeInput.js";
import { Icon } from "../../../components/icon/Icon.js";
import { ImageDetailModal } from "../../../components/image/ImageDetailModal.js";
import { ImagePreviewModal } from "../../../components/image/ImagePreviewModal.js";
import { WorkflowCollapsePanel } from "../../../components/layout/WorkflowCollapsePanel.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import { AdminPagination } from "../../../components/navigation/AdminPagination.js";
import {
  uploadCommonBrightnessOptions,
  uploadCommonDeviceOptions,
  type SelectOption
} from "../../../lib/ui/select-options.js";
import { copyTextToClipboard } from "../../../lib/ui/clipboard.js";
import type { FacetOption, ImageDraft, ImageItem, ImportJob } from "../../../lib/types.js";
import type { ImportAttributeDefaults } from "../../../lib/upload/upload-utils.js";
import type { ImportPreviewTarget } from "./DuplicateMatchPanel.js";
import { ImportJobList } from "./ImportJobList.js";
import type { JsonlManifestParseError } from "./import-api.js";
import {
  LinkUrlDialog,
  type LinkDialogSubmission,
  type LinkInputMode
} from "./link-import/LinkUrlDialog.js";
import {
  UploadCleanupMenu,
  type UploadCleanupAction
} from "./UploadCleanupMenu.js";
import type { ImportQueueController } from "./useImportQueue.js";

export function UploadWorkflowWindow({
  mode,
  fileInputId,
  closing,
  onAnimationEnd,
  dialogRef,
  listRef,
  closeButtonRef,
  fileInputRef,
  linkPickerRef,
  busy,
  queue,
  jsonlErrors,
  cleanupActions,
  defaults,
  defaultsExpanded,
  defaultsSummary,
  canApplyDefaults,
  themes,
  tags,
  authors,
  storageName,
  activeBackend,
  backendOptions,
  dragOver,
  detailItem,
  detailReturnFocusRef,
  preview,
  previewReturnFocusRef,
  urlInputOpen,
  linkInputMode,
  linkMaxItems,
  weiboMaxItems,
  onRequestClose,
  onAddFiles,
  onClearJsonlErrors,
  onDefaultsChange,
  onDefaultsExpandedChange,
  onDragOverChange,
  onPatchJob,
  onCancelJob,
  onRetryJob,
  onRemoveJob,
  onConfirmDuplicateJob,
  onOpenDetail,
  onOpenPreview,
  onOpenLinkInput,
  onBackendChange,
  onCancelAndClose,
  onCommitReady,
  onCloseDetail,
  onClosePreview,
  onCloseLinkInput,
  onSubmitLinks
}: {
  mode: "file" | "link";
  fileInputId: string;
  closing: boolean;
  onAnimationEnd: AnimationEventHandler<HTMLDivElement>;
  dialogRef: RefObject<HTMLElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  linkPickerRef: RefObject<HTMLButtonElement | null>;
  busy: boolean;
  queue: ImportQueueController;
  jsonlErrors: JsonlManifestParseError[];
  cleanupActions: UploadCleanupAction[];
  defaults: ImportAttributeDefaults;
  defaultsExpanded: boolean;
  defaultsSummary: string;
  canApplyDefaults: boolean;
  themes: FacetOption[];
  tags: FacetOption[];
  authors: FacetOption[];
  storageName: (slug: string) => string;
  activeBackend: string;
  backendOptions: readonly SelectOption[];
  dragOver: boolean;
  detailItem: ImageItem | null;
  detailReturnFocusRef: RefObject<HTMLElement | null>;
  preview: ImportPreviewTarget | null;
  previewReturnFocusRef: RefObject<HTMLElement | null>;
  urlInputOpen: boolean;
  linkInputMode: LinkInputMode;
  linkMaxItems: number;
  weiboMaxItems: number;
  onRequestClose: () => void;
  onAddFiles: (files: FileList | null) => void;
  onClearJsonlErrors: () => void;
  onDefaultsChange: Dispatch<SetStateAction<ImportAttributeDefaults>>;
  onDefaultsExpandedChange: (expanded: boolean) => void;
  onDragOverChange: (dragOver: boolean) => void;
  onPatchJob: (job: ImportJob, patch: Partial<ImageDraft>) => void;
  onCancelJob: (job: ImportJob) => void;
  onRetryJob: (job: ImportJob) => void;
  onRemoveJob: (job: ImportJob) => void;
  onConfirmDuplicateJob: (job: ImportJob) => void;
  onOpenDetail: (item: ImageItem, opener: HTMLElement) => void;
  onOpenPreview: (target: ImportPreviewTarget) => void;
  onOpenLinkInput: () => void;
  onBackendChange: (backend: string) => void;
  onCancelAndClose: () => void;
  onCommitReady: () => void;
  onCloseDetail: () => void;
  onClosePreview: () => void;
  onCloseLinkInput: () => void;
  onSubmitLinks: (submission: LinkDialogSubmission) => void;
}) {
  const {
    readyJobs,
    duplicateJobs,
    runningJobs,
    doneJobs,
    failedJobs,
    skippedJobs
  } = queue.summary;
  const modeTitle = mode === "file" ? "上传图片" : "导入图片";
  const emptySubtitle = mode === "file"
    ? "选择后立即上传并在服务端准备图片"
    : "输入来源后立即创建并准备图片任务";

  return (
    <div
      className={`upload-overlay ${closing ? "is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={modeTitle}
      onAnimationEnd={onAnimationEnd}
    >
      <section ref={dialogRef} className="upload-window" tabIndex={-1}>
        <header className="upload-window-header">
          <div className="upload-head-copy">
            <h1>{modeTitle}</h1>
            {queue.jobs.length ? (
              <p className="upload-task-summary">
                <span className="upload-summary-primary">
                  共 {queue.jobs.length} 张图片，{runningJobs} 张处理中，{readyJobs.length} 张待提交；
                </span>
                <span className="upload-summary-secondary">
                  {doneJobs} 张成功，{skippedJobs} 张跳过，{failedJobs} 张失败，{duplicateJobs} 张重复待确认
                  {jsonlErrors.length ? `，${jsonlErrors.length} 行解析失败` : ""}
                </span>
              </p>
            ) : (
              <p className="upload-empty-subtitle">{emptySubtitle}</p>
            )}
          </div>
          <div className="upload-head-actions">
            <div className="upload-clear-actions">
              {cleanupActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="clear-button"
                  disabled={busy || !action.enabled}
                  onClick={action.run}
                >
                  {action.label}
                </button>
              ))}
            </div>
            <div className="upload-primary-actions">
              <UploadCleanupMenu disabled={busy} actions={cleanupActions} />
              {mode === "link" ? (
                <button
                  ref={linkPickerRef}
                  type="button"
                  className="button secondary upload-picker pressable"
                  disabled={busy}
                  onClick={onOpenLinkInput}
                >
                  <Icon name="download-cloud-2-line" />选择来源
                </button>
              ) : (
                <label
                  className={`button secondary upload-picker pressable${busy ? " is-disabled" : ""}`}
                  aria-disabled={busy}
                >
                  <Icon name="upload-cloud-2-line" />
                  <input
                    id={fileInputId}
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    disabled={busy}
                    onChange={(event) => {
                      onAddFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  选择图片
                </label>
              )}
              <button
                ref={closeButtonRef}
                className="icon close pressable upload-close-button"
                type="button"
                title="关闭"
                onClick={onRequestClose}
                disabled={busy}
              >
                <Icon name="close-line" />
              </button>
            </div>
          </div>
        </header>

        <WorkflowCollapsePanel
          className="upload-defaults-panel"
          contentClassName="upload-defaults"
          title="默认属性"
          summary={defaultsSummary}
          expanded={defaultsExpanded}
          onExpandedChange={onDefaultsExpandedChange}
        >
          <SelectMenu
            className="upload-default-select upload-default-device"
            value={defaults.device}
            onChange={(device) => onDefaultsChange({
              ...defaults,
              device: device as ImportAttributeDefaults["device"]
            })}
            options={uploadCommonDeviceOptions}
            ariaLabel="默认设备"
          />
          <SelectMenu
            className="upload-default-select upload-default-brightness"
            value={defaults.brightness}
            onChange={(brightness) => onDefaultsChange({
              ...defaults,
              brightness: brightness as ImportAttributeDefaults["brightness"]
            })}
            options={uploadCommonBrightnessOptions}
            ariaLabel="默认亮度"
          />
          <div className="upload-default-pair">
            <ThemeInput
              className="upload-default-theme"
              value={defaults.theme}
              onChange={(theme) => onDefaultsChange({ ...defaults, theme })}
              themes={themes}
              placeholder="主题"
              ariaLabel="默认主题"
            />
            <AuthorInput
              className="upload-default-author"
              value={defaults.author}
              onChange={(author) => onDefaultsChange({ ...defaults, author })}
              authors={authors}
              placeholder="默认作者"
              ariaLabel="默认作者"
            />
            <TagInput
              className="upload-default-tags"
              value={defaults.tags}
              onChange={(nextTags) => onDefaultsChange({
                ...defaults,
                tags: nextTags
              })}
              suggestions={tags}
              placeholder="默认标签"
              ariaLabel="默认标签"
            />
          </div>
          <button
            type="button"
            className="apply-to-all-button"
            disabled={busy || !canApplyDefaults}
            onClick={() => queue.applyDefaultsToAll(defaults)}
          >
            应用到全部
          </button>
        </WorkflowCollapsePanel>

        <div className="modal-scroll-list upload-list" ref={listRef}>
          {jsonlErrors.length > 0 && (
            <div className="jsonl-import-report">
              <span>{jsonlErrors.length} 行未创建任务</span>
              <button
                type="button"
                onClick={() => void copyTextToClipboard(
                  jsonlErrors
                    .map((error) => `第 ${error.line} 行：${error.error}\n${error.raw}`)
                    .join("\n\n")
                ).catch(() => undefined)}
              >
                <Icon name="file-copy-line" />复制错误
              </button>
              <button type="button" onClick={onClearJsonlErrors}>清除</button>
            </div>
          )}
          <ImportJobList
            jobs={queue.visibleJobs}
            busy={busy}
            storageName={storageName}
            themes={themes}
            tags={tags}
            authors={authors}
            onPatch={onPatchJob}
            onCancel={onCancelJob}
            onRetry={onRetryJob}
            onRemove={onRemoveJob}
            onConfirmDuplicate={onConfirmDuplicateJob}
            onOpenDetail={onOpenDetail}
            onPreview={onOpenPreview}
          />
          {!queue.jobs.length && (mode === "link" ? (
            <button
              type="button"
              className="empty-state upload-dropzone"
              onClick={onOpenLinkInput}
            >
              <Icon name="download-cloud-2-line" />
              <span>还没有导入任务，点击此处选择图片来源</span>
            </button>
          ) : (
            <button
              type="button"
              className={`empty-state upload-dropzone${dragOver ? " is-dragover" : ""}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                onDragOverChange(true);
              }}
              onDragLeave={() => onDragOverChange(false)}
              onDrop={(event) => {
                event.preventDefault();
                onDragOverChange(false);
                onAddFiles(event.dataTransfer.files);
              }}
            >
              <Icon name="image-line" />
              <span>还没有选择图片，点击此处选择，或将图片拖到这里</span>
            </button>
          ))}
        </div>

        <AdminPagination
          className="upload-pagination"
          ariaLabel="导入任务列表分页"
          page={queue.page}
          totalPages={queue.totalPages}
          onPrevious={() => queue.setPage((page) => page - 1)}
          onNext={() => queue.setPage((page) => page + 1)}
        />

        <footer>
          <div className="upload-footer-left">
            <div className="upload-backend">
              <SelectMenu
                className="is-storage-select"
                value={activeBackend}
                onChange={onBackendChange}
                options={backendOptions}
                ariaLabel="新任务存储位置"
              />
            </div>
            <small className="upload-storage-hint">仅影响之后添加的新任务</small>
          </div>
          <AdminPagination
            className="upload-footer-pagination"
            ariaLabel="导入任务列表分页"
            page={queue.page}
            totalPages={queue.totalPages}
            onPrevious={() => queue.setPage((page) => page - 1)}
            onNext={() => queue.setPage((page) => page + 1)}
          />
          <div className="modal-footer-actions">
            <button type="button" onClick={onCancelAndClose} disabled={busy}>
              取消
            </button>
            <button
              className="button workflow-submit-button"
              type="button"
              disabled={!readyJobs.length || busy || duplicateJobs > 0}
              onClick={onCommitReady}
            >
              <StableButtonLabel
                idle={readyJobs.length ? `提交 ${readyJobs.length} 张` : "提交"}
                busyText="提交中"
                busy={busy}
              />
            </button>
          </div>
        </footer>
      </section>
      <OverlayScrollbar targetRef={listRef} />
      {detailItem && (
        <ImageDetailModal
          item={detailItem}
          admin
          onClose={onCloseDetail}
          returnFocusRef={detailReturnFocusRef}
        />
      )}
      {preview && (
        <ImagePreviewModal
          src={preview.src}
          thumbSrc={preview.thumbSrc}
          width={preview.width}
          height={preview.height}
          onClose={onClosePreview}
          returnFocusRef={previewReturnFocusRef}
        />
      )}
      {urlInputOpen && (
        <LinkUrlDialog
          initialInputMode={linkInputMode}
          maxItems={linkMaxItems}
          weiboMaxItems={weiboMaxItems}
          onClose={onCloseLinkInput}
          onSubmit={onSubmitLinks}
          returnFocusRef={linkPickerRef}
        />
      )}
    </div>
  );
}
