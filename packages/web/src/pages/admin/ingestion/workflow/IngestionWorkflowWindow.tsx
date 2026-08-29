import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from "react";
import { ConfirmDialog } from "../../../../components/feedback/ConfirmDialog.js";
import { DialogFrame } from "../../../../components/feedback/DialogFrame.js";
// 上传能力本身已经按需加载；不足 6 KiB（压缩后）的详情共享样式与逻辑留在
// 同一能力块，避免任务首击再产生一个懒加载边界。
import { ImageDetailModal } from "../../../../components/image/ImageDetailModal.js";
import { ImagePreviewModal } from "../../../../components/image/ImagePreviewModal.js";
import { OverlayScrollbar } from "../../../../components/layout/OverlayScrollbar.js";
import type { SelectOption } from "../../../../lib/ui/select-options.js";
import { useTwoStepConfirmation } from "../../../../hooks/useTwoStepConfirmation.js";
import { useIngestionDuplicateDetails } from "../queue/useIngestionDuplicateDetails.js";
import type {
  FacetOption,
  ImageDraft,
  AdminImageListItem,
  IngestionJob
} from "../../../../lib/types.js";
import type { IngestionAttributeDefaults } from "../queue/model/ingestion-attribute-defaults.js";
import type { IngestionPreviewTarget } from "../queue/cards/DuplicateMatchPanel.js";
import { ingestionJobPreviewAvailable } from "../queue/model/duplicate-match.js";
import type { ImportManifestParseError } from "../queue/ingestion-api.js";
import type {
  ImportSourceMode,
  ImportSourceSubmission
} from "../import/ImportSourceDialog.js";
import {
  createIngestionCleanupActions,
  type IngestionCleanupActionId
} from "./ingestion-cleanup-actions.js";
import type { IngestionQueueController } from "../queue/useIngestionQueue.js";
import {
  IngestionWorkflowDefaults,
  IngestionWorkflowFooter,
  IngestionWorkflowHeader,
  IngestionWorkflowQueueBody
} from "./IngestionWorkflowRegions.js";

type ImportSourceDialogComponent =
  typeof import("../import/ImportSourceDialog.js")["ImportSourceDialog"];

type IngestionWorkflowWindowProps = {
  mode: "upload" | "import";
  busy: boolean;
  queue: IngestionQueueController;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: (options?: Readonly<{
    skipCompletedCleanup?: boolean;
  }>) => void;
  defaults: IngestionAttributeDefaults;
  onDefaultsChange: (defaults: IngestionAttributeDefaults) => void;
  themes: FacetOption[];
  tags: FacetOption[];
  authors: FacetOption[];
  importParseErrors: ImportManifestParseError[];
  onClearImportParseErrors: () => void;
  storageName: (slug: string) => string;
  onAddFiles: (files: FileList | null) => void;
  onPatchJob: (job: IngestionJob, patch: Partial<ImageDraft>) => void;
  onCancelJob: (job: IngestionJob) => void;
  onRetryJob: (job: IngestionJob) => void;
  onRemoveJob: (job: IngestionJob) => void;
  onConfirmDuplicateJob: (job: IngestionJob) => void;
  onApplyDefaults: () => void;
  onCleanupAction: (action: IngestionCleanupActionId) => void;
  onArmCleanupAction: (
    action: IngestionCleanupActionId,
    confirmationCount: number
  ) => Readonly<{ count: number }> | false;
  onConfirmCleanupAction: (action: IngestionCleanupActionId) => Promise<boolean>;
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
  importMaxItems: number;
  weiboMaxItems: number;
  onOpenImportSource: (mode: ImportSourceMode) => void;
  onPreloadImportSource: () => void;
  onCloseImportSource: () => void;
  onSubmitImportSource: (submission: ImportSourceSubmission) => void;
};

const ingestionJobFocusableSelector = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  "[role='button']",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

type IngestionJobElementOwner = Readonly<{
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

function ingestionJobElementPath(card: HTMLElement, target: HTMLElement) {
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

function ingestionJobElementAtPath(
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

function ingestionJobElementOwner(
  job: IngestionJob,
  card: HTMLElement,
  target: HTMLElement
): IngestionJobElementOwner {
  const focusable = [...card.querySelectorAll<HTMLElement>(
    ingestionJobFocusableSelector
  )];
  return {
    jobId: job.id,
    attemptKey: job.attemptKey,
    sessionId: job.sessionId,
    imageId: job.imageId,
    element: target,
    path: ingestionJobElementPath(card, target),
    focusableIndex: focusable.indexOf(target),
    tagName: target.tagName,
    ariaLabel: target.getAttribute("aria-label"),
    title: target.getAttribute("title"),
    name: target.getAttribute("name"),
    role: target.getAttribute("role")
  };
}

function ingestionJobElementForOwner(
  card: HTMLElement,
  owner: IngestionJobElementOwner
) {
  const exact = ingestionJobElementAtPath(card, owner.path);
  const semanticMatch = (candidate: HTMLElement) => (
    candidate.tagName === owner.tagName
    && candidate.getAttribute("aria-label") === owner.ariaLabel
    && candidate.getAttribute("title") === owner.title
    && candidate.getAttribute("name") === owner.name
    && candidate.getAttribute("role") === owner.role
  );
  if (exact && semanticMatch(exact)) return exact;
  const focusable = [...card.querySelectorAll<HTMLElement>(
    ingestionJobFocusableSelector
  )];
  return focusable.find(semanticMatch)
    ?? (owner.focusableIndex >= 0 ? focusable[owner.focusableIndex] : null)
    ?? null;
}

export function IngestionWorkflowWindow({
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
  importParseErrors,
  onClearImportParseErrors,
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
  importMaxItems,
  weiboMaxItems,
  onOpenImportSource,
  onPreloadImportSource,
  onCloseImportSource,
  onSubmitImportSource
}: IngestionWorkflowWindowProps) {
  const fileInputId = useId();
  const [defaultsExpanded, setDefaultsExpanded] = useState(false);
  const [detailItem, setDetailItem] = useState<AdminImageListItem | null>(null);
  const [preview, setPreview] = useState<IngestionPreviewTarget | null>(null);
  const [pendingCleanup, setPendingCleanup] = useState<Readonly<{
    actionId: IngestionCleanupActionId;
    count: number;
    confirmationScope: string;
  }> | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sourcePickerRef = useRef<HTMLButtonElement | null>(null);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const detailLifecycleFocusRef = useRef<HTMLElement | null>(null);
  const detailOwnerRef = useRef<IngestionJobElementOwner | null>(null);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);
  const previewLifecycleFocusRef = useRef<HTMLElement | null>(null);
  const focusedJobElementRef = useRef<IngestionJobElementOwner | null>(null);
  const cleanupReturnFocusRef = useRef<HTMLElement | null>(null);
  const cleanupActions = createIngestionCleanupActions({
    counts: {
      duplicates: queue.summary.duplicateJobs,
      uncommitted: queue.uncommittedCount,
      completed: queue.summary.doneJobs
    },
    onClear: onCleanupAction
  });
  const duplicateDetails = useIngestionDuplicateDetails({
    jobs: queue.visibleJobs,
    updateJobs: queue.updateJobs,
    updateDuplicateDecision: queue.updateDuplicateDecision
  });
  const cleanupActionsRef = useRef(cleanupActions);
  cleanupActionsRef.current = cleanupActions;
  const pendingCleanupAction = pendingCleanup
    ? cleanupActions.find((action) => action.id === pendingCleanup.actionId)
    : undefined;
  const modeTitle = mode === "upload" ? "上传图片" : "导入图片";
  const emptySubtitle = mode === "upload"
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
      actionId: IngestionCleanupActionId,
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
    job: IngestionJob,
    item: AdminImageListItem,
    opener: HTMLElement
  ) => {
    const card = opener.closest<HTMLElement>("[data-ingestion-job-id]");
    detailOwnerRef.current = card
      ? ingestionJobElementOwner(job, card, opener)
      : null;
    detailReturnFocusRef.current = opener;
    setDetailItem(item);
  }, []);
  const captureJobFocus = useCallback((
    job: IngestionJob,
    card: HTMLElement,
    target: HTMLElement
  ) => {
    focusedJobElementRef.current = ingestionJobElementOwner(job, card, target);
  }, []);
  const openJobPreview = useCallback((target: IngestionPreviewTarget) => {
    previewReturnFocusRef.current = target.opener ?? null;
    setPreview(target);
  }, []);

  const cardForJob = useCallback((job: IngestionJob) => {
    const cards = listRef.current?.querySelectorAll<HTMLElement>(
      "[data-ingestion-job-id][data-ingestion-attempt-key]"
    );
    return [...cards ?? []].find((candidate) => (
      candidate.dataset.ingestionJobId === job.id
      && candidate.dataset.ingestionAttemptKey === job.attemptKey
    )) ?? null;
  }, []);
  const previewOpenerForJob = useCallback((job: IngestionJob) => (
    cardForJob(job)?.querySelector<HTMLElement>(
      ".ingestion-job-thumbnail[role='button']"
    ) ?? null
  ), [cardForJob]);

  useLayoutEffect(() => {
    const matchingJob = (owner: IngestionJobElementOwner) => (
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
    const transfer = (owner: IngestionJobElementOwner | null) => {
      if (!owner) return null;
      const job = matchingJob(owner);
      if (!job) return null;
      const card = cardForJob(job);
      if (!card) return null;
      const element = owner.element.isConnected && card.contains(owner.element)
        ? owner.element
        : ingestionJobElementForOwner(card, owner);
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
    if (exact && ingestionJobPreviewAvailable(exact)) {
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
    if (replacement && ingestionJobPreviewAvailable(replacement)) {
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
      className="ingestion-overlay"
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
            className="ingestion-window image-workflow-window"
            tabIndex={-1}
          >
            <IngestionWorkflowHeader
              mode={mode}
              modeTitle={modeTitle}
              emptySubtitle={emptySubtitle}
              counts={{
                total: queue.totalItems,
                waiting: waitingJobs,
                running: runningJobs,
                ready: readyCount,
                committing: committingJobs,
                done: doneJobs
              }}
              cleanup={{
                actions: cleanupActions,
                onSelect: selectCleanupAction
              }}
              source={{
                pending: sourceDialogPending,
                mode: importSourceMode,
                pickerRef: sourcePickerRef,
                onPreload: onPreloadImportSource,
                onOpen: onOpenImportSource
              }}
              file={{
                inputId: fileInputId,
                inputRef: fileInputRef,
                onAdd: onAddFiles
              }}
              closeButtonRef={closeButtonRef}
              onRequestClose={() => requestClose()}
            />
            <IngestionWorkflowDefaults
              defaults={defaults}
              expanded={defaultsExpanded}
              onExpandedChange={setDefaultsExpanded}
              onChange={onDefaultsChange}
              themes={themes}
              tags={tags}
              authors={authors}
              applyDisabled={queue.summary.unfinishedCount === 0}
              onApply={onApplyDefaults}
            />
            <IngestionWorkflowQueueBody
              listRef={listRef}
              mode={mode}
              busy={busy}
              queue={queue}
              duplicateDetails={duplicateDetails}
              importParseErrors={importParseErrors}
              onClearImportParseErrors={onClearImportParseErrors}
              storageName={storageName}
              vocabulary={{ themes, tags, authors }}
              jobActions={{
                onPatch: onPatchJob,
                onCancel: onCancelJob,
                onRetry: onRetryJob,
                onRemove: onRemoveJob,
                onConfirmDuplicate: onConfirmDuplicateJob,
                onOpenDetail: openJobDetail,
                onFocusWithin: captureJobFocus,
                onPreview: openJobPreview
              }}
              fileInputRef={fileInputRef}
              source={{
                pending: sourceDialogPending,
                onPreload: onPreloadImportSource,
                onOpen: onOpenImportSource,
                onAddFiles
              }}
            />
            <IngestionWorkflowFooter
              queue={queue}
              backend={{
                value: activeBackend,
                options: backendOptions,
                onChange: onBackendChange
              }}
              clear={{
                targetRef: clearConfirmation.targetRef,
                dangerous: clearRequiresConfirmation,
                armed: clearConfirmation.armed,
                ariaLabel: clearConfirmation.armed
                  ? "再次点击确认清空当前队列"
                  : clearRequiresConfirmation
                    ? "清空当前队列，需要再次点击确认"
                    : "清空当前队列",
                onBlur: clearConfirmation.onBlur,
                onClick: () => {
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
                }
              }}
              commit={{
                count: submitCount,
                pending: committingCount !== null,
                onClick: () => {
                  if (committingCount !== null || readyCount === 0) return;
                  setCommittingCount(readyCount);
                  void Promise.resolve(onCommitReady()).finally(() => {
                    setCommittingCount(null);
                  });
                }
              }}
            />
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
              maxItems={importMaxItems}
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
