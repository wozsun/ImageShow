import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject
} from "react";
import { StableButtonLabel } from "../../../components/data-display/StableButtonLabel.js";
import { ConfirmDialog } from "../../../components/feedback/ConfirmDialog.js";
import { DialogFrame } from "../../../components/feedback/DialogFrame.js";
import { WorkflowDefaultFields } from "../../../components/form/WorkflowDefaultFields.js";
import { SelectMenu } from "../../../components/form/SelectMenu.js";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
// 上传能力本身已经按需加载；不足 6 KiB（压缩后）的详情共享样式与逻辑留在
// 同一能力块，避免任务首击再产生一个懒加载边界。
import { ImageDetailModal } from "../../../components/image/ImageDetailModal.js";
import { ImagePreviewModal } from "../../../components/image/ImagePreviewModal.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import { WorkflowCollapsePanel } from "../../../components/layout/WorkflowCollapsePanel.js";
import { AdminPagination } from "../../../components/navigation/AdminPagination.js";
import type { SelectOption } from "../../../lib/ui/select-options.js";
import {
  uploadCommonBrightnessOptions,
  uploadCommonDeviceOptions
} from "../../../lib/ui/select-options.js";
import { copyTextToClipboard } from "../../../lib/ui/clipboard.js";
import { facetDisplayName } from "../../../lib/ui/formatters.js";
import { preloadIntentProps } from "../../../lib/ui/preload-intent.js";
import type {
  FacetOption,
  ImageDraft,
  AdminImageListItem,
  ImportJob
} from "../../../lib/types.js";
import type { ImportAttributeDefaults } from "../../../lib/upload/upload-utils.js";
import type { ImportPreviewTarget } from "./DuplicateMatchPanel.js";
import { ImportJobList } from "./ImportJobList.js";
import { UploadCleanupMenu } from "./UploadCleanupMenu.js";
import { canApplyImportAttributeDefaults } from "./import-attribute-policy.js";
import type { JsonlManifestParseError } from "./import-api.js";
import type {
  ImportSourceMode,
  ImportSourceSubmission
} from "./link-import/ImportSourceDialog.js";
import {
  createUploadCleanupActions,
  type UploadCleanupActionId
} from "./upload-cleanup-actions.js";
import type { ImportQueueController } from "./useImportQueue.js";

const sourceOptions: Array<[ImportSourceMode, string]> = [
  ["urls", "链接"],
  ["jsonl", "清单"],
  ["weibo", "微博"]
];

type ImportSourceDialogComponent =
  typeof import("./link-import/ImportSourceDialog.js")["ImportSourceDialog"];

type UploadWorkflowWindowProps = {
  mode: "file" | "link";
  busy: boolean;
  queue: ImportQueueController;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  defaults: ImportAttributeDefaults;
  onDefaultsChange: (defaults: ImportAttributeDefaults) => void;
  themes: FacetOption[];
  tags: FacetOption[];
  authors: FacetOption[];
  jsonlErrors: JsonlManifestParseError[];
  onClearJsonlErrors: () => void;
  storageName: (slug: string) => string;
  onAddFiles: (files: FileList | null) => void;
  onPatchJob: (job: ImportJob, patch: Partial<ImageDraft>) => void;
  onCancelJob: (job: ImportJob) => void;
  onRetryJob: (job: ImportJob) => void;
  onRemoveJob: (job: ImportJob) => void;
  onConfirmDuplicateJob: (job: ImportJob) => void;
  onClearJobs: (predicate: (job: ImportJob) => boolean) => Promise<void>;
  activeBackend: string;
  backendOptions: readonly SelectOption[];
  onBackendChange: (backend: string) => void;
  onCommitReady: () => void;
  sourceDialogPending: boolean;
  sourceDialogOpen: boolean;
  sourceDialogComponent: ImportSourceDialogComponent | null;
  importSourceMode: ImportSourceMode;
  autoImportAfterParse: boolean;
  linkMaxItems: number;
  weiboMaxItems: number;
  onOpenImportSource: (mode: ImportSourceMode) => void;
  onPreloadImportSource: () => void;
  onCloseImportSource: () => void;
  onSubmitImportSource: (submission: ImportSourceSubmission) => void;
};

export function UploadWorkflowWindow({
  mode,
  busy,
  queue,
  returnFocusRef,
  onClose,
  defaults,
  onDefaultsChange,
  themes,
  tags,
  authors,
  jsonlErrors,
  onClearJsonlErrors,
  storageName,
  onAddFiles,
  onPatchJob,
  onCancelJob,
  onRetryJob,
  onRemoveJob,
  onConfirmDuplicateJob,
  onClearJobs,
  activeBackend,
  backendOptions,
  onBackendChange,
  onCommitReady,
  sourceDialogPending,
  sourceDialogOpen,
  sourceDialogComponent: SourceDialog,
  importSourceMode,
  autoImportAfterParse,
  linkMaxItems,
  weiboMaxItems,
  onOpenImportSource,
  onPreloadImportSource,
  onCloseImportSource,
  onSubmitImportSource
}: UploadWorkflowWindowProps) {
  const fileInputId = useId();
  const [defaultsExpanded, setDefaultsExpanded] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [detailItem, setDetailItem] = useState<AdminImageListItem | null>(null);
  const [preview, setPreview] = useState<ImportPreviewTarget | null>(null);
  const [pendingCleanupActionId, setPendingCleanupActionId] =
    useState<UploadCleanupActionId | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sourcePickerRef = useRef<HTMLButtonElement | null>(null);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);
  const cleanupReturnFocusRef = useRef<HTMLElement | null>(null);
  const cleanupActions = createUploadCleanupActions({
    jobs: queue.jobs,
    busy,
    onClear: (predicate) => void onClearJobs(predicate)
  });
  const cleanupActionsRef = useRef(cleanupActions);
  cleanupActionsRef.current = cleanupActions;
  const pendingCleanupAction = pendingCleanupActionId
    ? cleanupActions.find((action) => action.id === pendingCleanupActionId)
    : undefined;
  const defaultsSummary = [
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
  const canApplyDefaults = useMemo(
    () => queue.jobs.some(
      (job) => canApplyImportAttributeDefaults(job, defaults)
    ),
    [defaults, queue.jobs]
  );
  const modeTitle = mode === "file" ? "上传图片" : "导入图片";
  const emptySubtitle = mode === "file"
    ? "选择后立即上传并在服务端准备图片"
    : "输入来源后立即创建并准备图片任务";
  const {
    readyJobs,
    duplicateJobs,
    runningJobs,
    doneJobs,
    failedJobs
  } = queue.summary;

  const selectCleanupAction = useCallback(
    (
      actionId: UploadCleanupActionId,
      returnFocusTarget: HTMLElement
    ) => {
      const action = cleanupActionsRef.current.find(
        (candidate) => candidate.id === actionId
      );
      if (!action?.enabled) return;
      if (!action.confirmation) {
        action.run();
        return;
      }
      cleanupReturnFocusRef.current = returnFocusTarget;
      setPendingCleanupActionId(actionId);
    },
    []
  );

  const confirmCleanupAction = useCallback(async () => {
    const action = cleanupActionsRef.current.find(
      (candidate) => candidate.id === pendingCleanupActionId
    );
    if (!action?.confirmation || !action.enabled || action.count === 0) {
      return false;
    }
    action.run();
    return true;
  }, [pendingCleanupActionId]);

  const openJobDetail = useCallback((item: AdminImageListItem, opener: HTMLElement) => {
    detailReturnFocusRef.current = opener;
    setDetailItem(item);
  }, []);
  const openJobPreview = useCallback((target: ImportPreviewTarget) => {
    previewReturnFocusRef.current = target.opener ?? null;
    setPreview(target);
  }, []);

  return (
    <DialogFrame
      className="upload-overlay"
      ariaLabel={modeTitle}
      busy={busy}
      paused={Boolean(
        detailItem
        || preview
        || sourceDialogOpen
        || pendingCleanupActionId
      )}
      initialFocusRef={closeButtonRef}
      returnFocusRef={returnFocusRef}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <>
          <section
            className="upload-window image-workflow-window"
            tabIndex={-1}
          >
            <header className="upload-window-header">
              <div className="upload-head-copy">
                <h1>{modeTitle}</h1>
                {queue.jobs.length ? (
                  <p className="upload-task-summary">
                    <span className="upload-summary-primary">
                      共 {queue.jobs.length} 张图片，{runningJobs} 张处理中，
                      {readyJobs.length} 张待提交；
                    </span>
                    <span className="upload-summary-secondary">
                      {doneJobs} 张成功，{failedJobs} 张失败，
                      {duplicateJobs} 张重复待确认
                      {jsonlErrors.length
                        ? `，${jsonlErrors.length} 行解析失败`
                        : ""}
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
                      disabled={!action.enabled}
                      onClick={(event) => {
                        selectCleanupAction(action.id, event.currentTarget);
                      }}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
                <div className="upload-primary-actions">
                  <UploadCleanupMenu
                    actions={cleanupActions}
                    onSelect={selectCleanupAction}
                  />
                  {mode === "link" ? (
                    <div
                      className={`upload-source-picker${
                        busy || sourceDialogPending ? " is-disabled" : ""
                      }`}
                      role="group"
                      aria-label="选择导入来源"
                      aria-disabled={busy || sourceDialogPending}
                    >
                      {sourceOptions.map(([sourceMode, label]) => (
                        <button
                          key={sourceMode}
                          ref={
                            importSourceMode === sourceMode
                              ? sourcePickerRef
                              : undefined
                          }
                          type="button"
                          className="upload-source-option pressable"
                          disabled={busy || sourceDialogPending}
                          {...preloadIntentProps(onPreloadImportSource)}
                          onClick={() => onOpenImportSource(sourceMode)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <label
                      className={`button secondary upload-picker pressable${
                        busy ? " is-disabled" : ""
                      }`}
                      aria-disabled={busy}
                    >
                      <AdminIcon name="upload-cloud-2-line" />
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
                    onClick={() => requestClose()}
                    disabled={busy}
                  >
                    <AdminIcon name="close-line" />
                  </button>
                </div>
              </div>
            </header>
            <WorkflowCollapsePanel
              className="upload-defaults-panel"
              contentClassName="upload-defaults workflow-defaults"
              title="默认属性"
              summary={defaultsSummary}
              expanded={defaultsExpanded}
              onExpandedChange={setDefaultsExpanded}
            >
              <WorkflowDefaultFields
                values={defaults}
                onChange={{
                  device: (device) => onDefaultsChange({
                    ...defaults,
                    device: device as ImportAttributeDefaults["device"]
                  }),
                  brightness: (brightness) => onDefaultsChange({
                    ...defaults,
                    brightness: brightness as ImportAttributeDefaults["brightness"]
                  }),
                  theme: (theme) => onDefaultsChange({ ...defaults, theme }),
                  author: (author) => onDefaultsChange({ ...defaults, author }),
                  tags: (nextTags) => onDefaultsChange({
                    ...defaults,
                    tags: nextTags
                  })
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
                applyDisabled={busy || !canApplyDefaults}
                onApply={() => queue.applyDefaultsToAll(defaults)}
              />
            </WorkflowCollapsePanel>
            <div
              className="modal-scroll-list image-workflow-list upload-list"
              ref={listRef}
            >
              {jsonlErrors.length > 0 && (
                <div className="jsonl-import-report">
                  <span>{jsonlErrors.length} 行未创建任务</span>
                  <button
                    type="button"
                    onClick={() => void copyTextToClipboard(
                      jsonlErrors
                        .map((error) => (
                          `第 ${error.line} 行：${error.error}\n${error.raw}`
                        ))
                        .join("\n\n")
                    ).catch(() => undefined)}
                  >
                    <AdminIcon name="file-copy-line" />复制错误
                  </button>
                  <button type="button" onClick={onClearJsonlErrors}>
                    清除
                  </button>
                </div>
              )}
              <ImportJobList
                jobs={queue.visibleJobs}
                allJobs={queue.jobs}
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
                onOpenDetail={openJobDetail}
                onPreview={openJobPreview}
              />
              {!queue.jobs.length && (mode === "link" ? (
                <button
                  type="button"
                  className="upload-empty-state upload-dropzone"
                  disabled={sourceDialogPending}
                  {...preloadIntentProps(onPreloadImportSource)}
                  onClick={() => onOpenImportSource("urls")}
                >
                  <AdminIcon name="download-cloud-2-line" />
                  <span>还没有导入任务，点击此处选择图片来源</span>
                </button>
              ) : (
                <button
                  type="button"
                  className={`upload-empty-state upload-dropzone${
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
                    onAddFiles(event.dataTransfer.files);
                  }}
                >
                  <AdminIcon name="image-line" />
                  <span>还没有选择图片，点击此处选择，或将图片拖到这里</span>
                </button>
              ))}
            </div>
            <footer
              className={`image-workflow-footer${
                queue.totalPages > 1 ? " has-pagination" : ""
              }`}
            >
              <div className="upload-footer-left image-workflow-leading-actions">
                <div className="upload-backend">
                  <SelectMenu
                    className="is-storage-select"
                    value={activeBackend}
                    onChange={onBackendChange}
                    options={backendOptions}
                    ariaLabel="新任务存储位置"
                  />
                </div>
                <small className="upload-storage-hint">
                  仅影响之后添加的新任务
                </small>
              </div>
              {queue.totalPages > 1 && (
                <AdminPagination
                  className="image-workflow-pagination"
                  ariaLabel="导入任务列表分页"
                  page={queue.page}
                  totalPages={queue.totalPages}
                  onPageChange={queue.setPage}
                />
              )}
              <div className="modal-footer-actions">
                <button
                  type="button"
                  onClick={() => void onClearJobs(() => true).then(
                    () => requestClose()
                  )}
                  disabled={busy}
                >
                  取消
                </button>
                <button
                  className="button workflow-submit-button"
                  type="button"
                  disabled={!readyJobs.length || busy}
                  onClick={onCommitReady}
                >
                  <StableButtonLabel
                    idle={readyJobs.length
                      ? `提交 ${readyJobs.length} 张`
                      : "提交"}
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
              storageLabel={storageName(detailItem.storage_slug)}
              onClose={() => setDetailItem(null)}
              onTrashed={(imageId) => {
                detailReturnFocusRef.current = null;
                queue.removeLibraryDuplicate(imageId);
              }}
              returnFocusRef={detailReturnFocusRef}
            />
          )}
          {preview && (
            <ImagePreviewModal
              src={preview.src}
              thumbSrc={preview.thumbSrc}
              width={preview.width}
              height={preview.height}
              onClose={() => setPreview(null)}
              returnFocusRef={previewReturnFocusRef}
            />
          )}
          {sourceDialogOpen && SourceDialog && (
            <SourceDialog
              initialMode={importSourceMode}
              autoImportAfterParse={autoImportAfterParse}
              maxItems={linkMaxItems}
              weiboMaxItems={weiboMaxItems}
              onClose={onCloseImportSource}
              onSubmit={onSubmitImportSource}
              returnFocusRef={sourcePickerRef}
            />
          )}
          {pendingCleanupAction?.confirmation && (
            <ConfirmDialog
              title={pendingCleanupAction.confirmation.title}
              description={pendingCleanupAction.confirmation.description(
                pendingCleanupAction.count
              )}
              confirmLabel={pendingCleanupAction.confirmation.confirmLabel(
                pendingCleanupAction.count
              )}
              pendingLabel="清空中"
              successLabel="已清空"
              confirmDisabled={!pendingCleanupAction.enabled}
              closeOnBackdrop
              returnFocusRef={cleanupReturnFocusRef}
              onClose={() => setPendingCleanupActionId(null)}
              onConfirm={confirmCleanupAction}
            />
          )}
        </>
      )}
    </DialogFrame>
  );
}
