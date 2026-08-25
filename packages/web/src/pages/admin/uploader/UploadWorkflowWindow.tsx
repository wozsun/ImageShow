import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from "react";
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
import { useTwoStepConfirmation } from "../../../hooks/useTwoStepConfirmation.js";
import { useImportDuplicateDetails } from "./useImportDuplicateDetails.js";
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
import { importJobPreviewAvailable } from "./duplicate-match.js";
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
  onClose: (options?: Readonly<{
    skipCompletedCleanup?: boolean;
  }>) => void;
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
  onApplyDefaults: () => void;
  onCleanupAction: (action: UploadCleanupActionId) => void;
  onArmCleanupAction: (
    action: UploadCleanupActionId,
    confirmationCount: number
  ) => Readonly<{ count: number }> | false;
  onConfirmCleanupAction: (action: UploadCleanupActionId) => Promise<boolean>;
  onDiscardUnconfirmedIntents: () => void;
  confirmationScope: string;
  onArmClearQueue: () => boolean;
  onConfirmClearQueue: () => Promise<boolean>;
  activeBackend: string;
  backendOptions: readonly SelectOption[];
  onBackendChange: (backend: string) => void;
  onCommitReady: () => Promise<void>;
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

const importJobFocusableSelector = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  "[role='button']",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

type ImportJobElementOwner = Readonly<{
  jobId: string;
  attemptKey: string;
  sessionId?: string;
  imageId?: string;
  element: HTMLElement;
  path: readonly number[];
  focusableIndex: number;
  tagName: string;
  ariaLabel: string | null;
  title: string | null;
  name: string | null;
  role: string | null;
}>;

function importJobElementPath(card: HTMLElement, target: HTMLElement) {
  const path: number[] = [];
  let current: HTMLElement | null = target;
  while (current && current !== card) {
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) return [];
    path.push([...parent.children].indexOf(current));
    current = parent;
  }
  return current === card ? path.reverse() : [];
}

function importJobElementAtPath(
  card: HTMLElement,
  path: readonly number[]
) {
  let current: HTMLElement = card;
  for (const index of path) {
    const child: Element | undefined = [...current.children][index];
    if (!(child instanceof HTMLElement)) return null;
    current = child;
  }
  return current;
}

function importJobElementOwner(
  job: ImportJob,
  card: HTMLElement,
  target: HTMLElement
): ImportJobElementOwner {
  const focusable = [...card.querySelectorAll<HTMLElement>(
    importJobFocusableSelector
  )];
  return {
    jobId: job.id,
    attemptKey: job.attemptKey,
    sessionId: job.sessionId,
    imageId: job.imageId,
    element: target,
    path: importJobElementPath(card, target),
    focusableIndex: focusable.indexOf(target),
    tagName: target.tagName,
    ariaLabel: target.getAttribute("aria-label"),
    title: target.getAttribute("title"),
    name: target.getAttribute("name"),
    role: target.getAttribute("role")
  };
}

function importJobElementForOwner(
  card: HTMLElement,
  owner: ImportJobElementOwner
) {
  const exact = importJobElementAtPath(card, owner.path);
  const semanticMatch = (candidate: HTMLElement) => (
    candidate.tagName === owner.tagName
    && candidate.getAttribute("aria-label") === owner.ariaLabel
    && candidate.getAttribute("title") === owner.title
    && candidate.getAttribute("name") === owner.name
    && candidate.getAttribute("role") === owner.role
  );
  if (exact && semanticMatch(exact)) return exact;
  const focusable = [...card.querySelectorAll<HTMLElement>(
    importJobFocusableSelector
  )];
  return focusable.find(semanticMatch)
    ?? (owner.focusableIndex >= 0 ? focusable[owner.focusableIndex] : null)
    ?? null;
}

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
  onApplyDefaults,
  onCleanupAction,
  onArmCleanupAction,
  onConfirmCleanupAction,
  onDiscardUnconfirmedIntents,
  confirmationScope,
  onArmClearQueue,
  onConfirmClearQueue,
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
  const [pendingCleanup, setPendingCleanup] = useState<Readonly<{
    actionId: UploadCleanupActionId;
    count: number;
    confirmationScope: string;
  }> | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sourcePickerRef = useRef<HTMLButtonElement | null>(null);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const detailLifecycleFocusRef = useRef<HTMLElement | null>(null);
  const detailOwnerRef = useRef<ImportJobElementOwner | null>(null);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);
  const previewLifecycleFocusRef = useRef<HTMLElement | null>(null);
  const focusedJobElementRef = useRef<ImportJobElementOwner | null>(null);
  const cleanupReturnFocusRef = useRef<HTMLElement | null>(null);
  const serverReady = queue.server.status === "ready";
  const cleanupActions = createUploadCleanupActions({
    counts: {
      duplicates: queue.summary.duplicateJobs,
      uncommitted: queue.uncommittedCount,
      completed: queue.summary.doneJobs
    },
    onClear: onCleanupAction
  });
  const duplicateDetails = useImportDuplicateDetails({
    jobs: queue.visibleJobs,
    updateJobs: queue.updateJobs,
    updateDuplicateDecision: queue.updateDuplicateDecision
  });
  const cleanupActionsRef = useRef(cleanupActions);
  cleanupActionsRef.current = cleanupActions;
  const pendingCleanupAction = pendingCleanup
    ? cleanupActions.find((action) => action.id === pendingCleanup.actionId)
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
  const modeTitle = mode === "file" ? "上传图片" : "导入图片";
  const emptySubtitle = mode === "file"
    ? "选择后立即上传并在服务端准备图片"
    : "输入来源后立即创建并准备图片任务";
  const {
    readyCount,
    waitingJobs: stageWaitingJobs,
    runningJobs,
    commitQueuedJobs,
    committingJobs,
    finalizedJobs,
    doneJobs
  } = queue.summary;
  const [committingCount, setCommittingCount] = useState<number | null>(null);
  const submitCount = committingCount ?? readyCount;
  const serverFailed = queue.server.status === "error";
  const waitingJobs = stageWaitingJobs + commitQueuedJobs + finalizedJobs;
  const clearDangerous = queue.summary.unfinishedCount > 0;
  const clearConfirmation = useTwoStepConfirmation<HTMLButtonElement>({
    invalidationKey: confirmationScope,
    onDisarm: onDiscardUnconfirmedIntents
  });
  const clearRequiresConfirmation = clearDangerous
    || clearConfirmation.armed;

  useEffect(() => {
    if (
      pendingCleanup
      && pendingCleanup.confirmationScope !== confirmationScope
    ) {
      onDiscardUnconfirmedIntents();
      setPendingCleanup(null);
    }
  }, [confirmationScope, onDiscardUnconfirmedIntents, pendingCleanup]);

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
      const confirmation = onArmCleanupAction(actionId, action.count);
      if (!confirmation) return;
      cleanupReturnFocusRef.current = returnFocusTarget;
      setPendingCleanup({
        actionId,
        count: confirmation.count,
        confirmationScope
      });
    },
    [confirmationScope, onArmCleanupAction]
  );

  const confirmCleanupAction = useCallback(async () => {
    if (!pendingCleanup) return false;
    return onConfirmCleanupAction(pendingCleanup.actionId);
  }, [onConfirmCleanupAction, pendingCleanup]);

  const openJobDetail = useCallback((
    job: ImportJob,
    item: AdminImageListItem,
    opener: HTMLElement
  ) => {
    const card = opener.closest<HTMLElement>("[data-import-job-id]");
    detailOwnerRef.current = card
      ? importJobElementOwner(job, card, opener)
      : null;
    detailReturnFocusRef.current = opener;
    setDetailItem(item);
  }, []);
  const captureJobFocus = useCallback((
    job: ImportJob,
    card: HTMLElement,
    target: HTMLElement
  ) => {
    focusedJobElementRef.current = importJobElementOwner(job, card, target);
  }, []);
  const openJobPreview = useCallback((target: ImportPreviewTarget) => {
    previewReturnFocusRef.current = target.opener ?? null;
    setPreview(target);
  }, []);

  const cardForJob = useCallback((job: ImportJob) => {
    const cards = listRef.current?.querySelectorAll<HTMLElement>(
      "[data-import-job-id][data-import-attempt-key]"
    );
    return [...cards ?? []].find((candidate) => (
      candidate.dataset.importJobId === job.id
      && candidate.dataset.importAttemptKey === job.attemptKey
    )) ?? null;
  }, []);
  const previewOpenerForJob = useCallback((job: ImportJob) => (
    cardForJob(job)?.querySelector<HTMLElement>(
      ".import-job-thumbnail[role='button']"
    ) ?? null
  ), [cardForJob]);

  useLayoutEffect(() => {
    const matchingJob = (owner: ImportJobElementOwner) => (
      queue.visibleJobs.find((job) => (
        job.id === owner.jobId && job.attemptKey === owner.attemptKey
      ))
      ?? (owner.sessionId && owner.imageId
        ? queue.visibleJobs.find((job) => (
            job.sessionId === owner.sessionId
            && job.imageId?.toLowerCase() === owner.imageId?.toLowerCase()
          ))
        : undefined)
      ?? (owner.sessionId
        ? queue.visibleJobs.find((job) => job.sessionId === owner.sessionId)
        : undefined)
    );
    const transfer = (owner: ImportJobElementOwner | null) => {
      if (!owner) return null;
      const job = matchingJob(owner);
      if (!job) return null;
      const card = cardForJob(job);
      if (!card) return null;
      const element = owner.element.isConnected && card.contains(owner.element)
        ? owner.element
        : importJobElementForOwner(card, owner);
      return element ? {
        ...owner,
        jobId: job.id,
        attemptKey: job.attemptKey,
        sessionId: job.sessionId,
        imageId: job.imageId,
        element
      } : null;
    };

    const previousFocused = focusedJobElementRef.current;
    if (previousFocused) {
      const previousElementLost = !previousFocused.element.isConnected;
      const transferred = transfer(previousFocused);
      focusedJobElementRef.current = transferred;
      const activeElement = document.activeElement;
      const focusWasLost = !(activeElement instanceof HTMLElement)
        || activeElement === document.body
        || !activeElement.isConnected;
      if (
        transferred
        && previousElementLost
        && focusWasLost
        && !detailItem
        && !preview
        && !sourceDialogOpen
        && !pendingCleanup
      ) transferred.element.focus({ preventScroll: true });
    }

    if (detailItem && detailOwnerRef.current) {
      const transferred = transfer(detailOwnerRef.current);
      detailOwnerRef.current = transferred;
      detailReturnFocusRef.current = transferred?.element
        ?? closeButtonRef.current;
    }
  }, [
    cardForJob,
    detailItem,
    pendingCleanup,
    preview,
    queue.visibleJobs,
    sourceDialogOpen
  ]);

  useLayoutEffect(() => {
    if (!preview) return;
    const exact = queue.visibleJobs.find((job) => (
      job.id === preview.jobId && job.attemptKey === preview.attemptKey
    ));
    if (exact && importJobPreviewAvailable(exact)) {
      const opener = preview.opener?.isConnected
        ? preview.opener
        : previewOpenerForJob(exact) ?? undefined;
      const next = {
        ...preview,
        sessionId: exact.sessionId,
        imageId: exact.imageId,
        src: exact.previewFull || exact.preview,
        thumbSrc: exact.preview,
        width: exact.width,
        height: exact.height,
        opener
      };
      if (
        next.sessionId !== preview.sessionId
        || next.imageId?.toLowerCase() !== preview.imageId?.toLowerCase()
        || next.src !== preview.src
        || next.thumbSrc !== preview.thumbSrc
        || next.width !== preview.width
        || next.height !== preview.height
        || next.opener !== preview.opener
      ) {
        previewReturnFocusRef.current = opener ?? null;
        setPreview(next);
      }
      return;
    }

    const replacement = preview.sessionId
      ? queue.visibleJobs.find((job) => job.sessionId === preview.sessionId)
      : undefined;
    if (replacement && importJobPreviewAvailable(replacement)) {
      const opener = previewOpenerForJob(replacement) ?? undefined;
      previewReturnFocusRef.current = opener ?? null;
      setPreview({
        jobId: replacement.id,
        attemptKey: replacement.attemptKey,
        sessionId: replacement.sessionId,
        imageId: replacement.imageId,
        src: replacement.previewFull || replacement.preview,
        thumbSrc: replacement.preview,
        width: replacement.width,
        height: replacement.height,
        opener
      });
      return;
    }
    const focusTarget = replacement ? previewOpenerForJob(replacement) : null;
    previewLifecycleFocusRef.current = focusTarget ?? closeButtonRef.current;
    previewReturnFocusRef.current = previewLifecycleFocusRef.current;
    setPreview(null);
  }, [preview, previewOpenerForJob, queue.visibleJobs]);

  useLayoutEffect(() => {
    if (preview) return;
    const focusTarget = previewLifecycleFocusRef.current;
    previewLifecycleFocusRef.current = null;
    if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
  }, [preview]);

  const closeJobPreview = useCallback(() => {
    previewLifecycleFocusRef.current = preview?.opener?.isConnected
      ? preview.opener
      : closeButtonRef.current;
    setPreview(null);
  }, [preview]);

  const closeJobDetail = useCallback(() => {
    const returnTarget = detailReturnFocusRef.current;
    detailLifecycleFocusRef.current = returnTarget?.isConnected
      ? returnTarget
      : closeButtonRef.current;
    detailOwnerRef.current = null;
    setDetailItem(null);
  }, []);

  useLayoutEffect(() => {
    if (detailItem) return;
    const focusTarget = detailLifecycleFocusRef.current;
    detailLifecycleFocusRef.current = null;
    if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
  }, [detailItem]);

  return (
    <DialogFrame
      className="upload-overlay"
      ariaLabel={modeTitle}
      paused={Boolean(
        detailItem
        || preview
        || sourceDialogOpen
        || pendingCleanup
      )}
      initialFocusRef={closeButtonRef}
      returnFocusRef={returnFocusRef}
      onClose={() => {
        onDiscardUnconfirmedIntents();
        onClose();
      }}
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
                {queue.totalItems > 0 ? (
                  <p className="upload-task-summary">
                    <span className="upload-summary-primary">
                      共 {queue.totalItems} 张图片，{waitingJobs} 张等待中，
                      {runningJobs} 张处理中；
                    </span>
                    <span className="upload-summary-secondary">
                      {readyCount} 张待提交，{committingJobs} 张提交中，
                      {doneJobs} 张已完成
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
                        sourceDialogPending ? " is-disabled" : ""
                      }`}
                      role="group"
                      aria-label="选择导入来源"
                      aria-disabled={sourceDialogPending}
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
                          disabled={sourceDialogPending}
                          {...preloadIntentProps(onPreloadImportSource)}
                          onClick={() => onOpenImportSource(sourceMode)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <label className="button secondary upload-picker pressable">
                      <AdminIcon name="upload-cloud-2-line" />
                      <input
                        id={fileInputId}
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
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
                applyDisabled={queue.summary.unfinishedCount === 0}
                onApply={onApplyDefaults}
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
              {queue.serverNotice && (
                <div className="jsonl-import-report" role="status">
                  <span>{queue.serverNotice}</span>
                  {queue.serverNoticeRetryable && (
                    <button type="button" onClick={queue.retryServerNotice}>
                      <AdminIcon name="refresh-line" />重试
                    </button>
                  )}
                </div>
              )}
              {queue.actions.notice && (
                <div className="jsonl-import-report" role="status">
                  <span>{queue.actions.notice}</span>
                </div>
              )}
              {duplicateDetails.error && (
                <div className="jsonl-import-report" role="alert">
                  <span>{duplicateDetails.error}</span>
                  <button type="button" onClick={duplicateDetails.refresh}>
                    <AdminIcon name="refresh-line" />重试
                  </button>
                </div>
              )}
              {serverFailed && (
                <div className="jsonl-import-report" role="alert">
                  <span>{queue.server.error || "服务端队列读取失败"}</span>
                  <button type="button" onClick={queue.server.refresh}>
                    <AdminIcon name="refresh-line" />重试
                  </button>
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
                onOpenDetail={openJobDetail}
                onFocusWithin={captureJobFocus}
                onPreview={openJobPreview}
              />
              {serverReady && queue.totalItems === 0 && (mode === "link" ? (
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
                  ref={clearConfirmation.targetRef}
                  type="button"
                  className={[
                    "upload-queue-clear-button",
                    clearRequiresConfirmation ? "danger-button" : "",
                    clearConfirmation.armed ? "is-armed" : ""
                  ].filter(Boolean).join(" ")}
                  aria-label={clearConfirmation.armed
                    ? "再次点击确认清空当前队列"
                    : clearRequiresConfirmation
                      ? "清空当前队列，需要再次点击确认"
                      : "清空当前队列"}
                  aria-pressed={clearConfirmation.armed}
                  onBlur={clearConfirmation.onBlur}
                  onClick={() => {
                    if (queue.totalItems === 0) {
                      requestClose();
                      return;
                    }
                    const run = () => {
                      void onConfirmClearQueue().then((closed) => {
                        if (closed) {
                          requestClose(() => {
                            onDiscardUnconfirmedIntents();
                            onClose({ skipCompletedCleanup: true });
                          });
                        }
                      });
                    };
                    if (!clearRequiresConfirmation) {
                      if (onArmClearQueue()) run();
                      return;
                    }
                    clearConfirmation.activate(onArmClearQueue, run);
                  }}
                >
                  {clearConfirmation.armed ? "清空" : "取消"}
                </button>
                <button
                  className="button workflow-submit-button"
                  type="button"
                  disabled={!submitCount || committingCount !== null}
                  onClick={() => {
                    if (committingCount !== null || readyCount === 0) return;
                    setCommittingCount(readyCount);
                    void Promise.resolve(onCommitReady()).finally(() => {
                      setCommittingCount(null);
                    });
                  }}
                >
                  {submitCount ? `提交 ${submitCount} 张` : "提交"}
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
              onClose={closeJobDetail}
              onTrashed={(imageId) => {
                detailOwnerRef.current = null;
                detailReturnFocusRef.current = null;
                detailLifecycleFocusRef.current = closeButtonRef.current;
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
              onClose={closeJobPreview}
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
                pendingCleanup?.count ?? 0
              )}
              confirmLabel={pendingCleanupAction.confirmation.confirmLabel(
                pendingCleanup?.count ?? 0
              )}
              pendingLabel="清空中"
              successLabel="已清空"
              closeOnBackdrop
              returnFocusRef={cleanupReturnFocusRef}
              onClose={() => {
                onDiscardUnconfirmedIntents();
                setPendingCleanup(null);
              }}
              onConfirm={confirmCleanupAction}
            />
          )}
        </>
      )}
    </DialogFrame>
  );
}
