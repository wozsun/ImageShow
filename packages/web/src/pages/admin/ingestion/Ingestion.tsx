import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { AdminSettings } from "@imageshow/shared/browser";
import { storageBackendLabel } from "../../../lib/ui/select-options.js";
import { useIngestionVocabulary } from "../../../lib/api/ingestion-vocabulary.js";
import {
  storageNameResolver,
  useStorageOptions
} from "../../../lib/api/storage-options.js";
import type { FacetOption, IngestionJob } from "../../../lib/types.js";
import type { IngestionAttributeDefaults } from "./queue/model/ingestion-attribute-defaults.js";
import { ingestionJobNeedsDuplicateConfirmation } from "./queue/model/duplicate-match.js";
import {
  ingestionJobCanBeCancelled,
  ingestionJobCanBeRemovedLocally,
  ingestionJobCanStartCommit
} from "./queue/model/ingestion-queue-state.js";
import type {
  ImportSourceMode,
  ImportSourceSubmission
} from "./import/ImportSourceDialog.js";
import { createManifestImportJobs } from "./import/manifest-jobs.js";
import type { ImportManifestParseError } from "./queue/ingestion-api.js";
import {
  useImportQueueOwner,
  useUploadQueueOwner
} from "./workflow/useIngestionQueueOwners.js";
import { useIngestionQueueWorkflowActions } from "./workflow/useIngestionQueueWorkflowActions.js";
import { AsyncIntentFence } from "../../../lib/async-intent-fence.js";
import { IngestionWorkflowWindow } from "./workflow/IngestionWorkflowWindow.js";
import {
  type IngestionActivation
} from "./ingestion-activation.js";
import "../../../styles/admin/image-workflow.css";
import "../../../styles/admin/ingestion.css";

const EMPTY_FACET_OPTIONS: FacetOption[] = [];
type ImportSourceDialogModule =
  typeof import("./import/ImportSourceDialog.js");

export function Ingestion({
  settings,
  activation,
  activationEnabled,
  loadImportSourceModule,
  onActivationOpened,
  onActivationSettled,
  onDone,
  onLoadError
}: {
  settings: AdminSettings;
  activation: IngestionActivation | null;
  activationEnabled: boolean;
  loadImportSourceModule: () => Promise<ImportSourceDialogModule>;
  onActivationOpened: (sequence: number) => void;
  onActivationSettled: (sequence: number) => void;
  onDone: () => void;
  onLoadError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"upload" | "import">("upload");
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [sourceDialogPending, setSourceDialogPending] = useState(false);
  const [ImportSourceDialogComponent, setImportSourceDialogComponent] =
    useState<ImportSourceDialogModule["ImportSourceDialog"] | null>(null);
  const [importSourceMode, setImportSourceMode] =
    useState<ImportSourceMode>("urls");
  const [importParseErrors, setImportParseErrors] =
    useState<ImportManifestParseError[]>([]);
  const [defaults, setDefaults] = useState<IngestionAttributeDefaults>({
    device: "auto",
    brightness: "auto",
    theme: "",
    author: "",
    tags: []
  });
  const workflowReturnFocusRef = useRef<HTMLElement | null>(null);
  const processedActivationRef = useRef(0);
  const intentFenceRef = useRef(new AsyncIntentFence());

  useEffect(() => {
    const intentFence = intentFenceRef.current;
    // 挂载状态与意图序号分开：真实卸载会拒绝迟到回调，而开发环境的
    // StrictMode effect 重放不会丢掉 processedActivationRef 已接管的首次激活。
    intentFence.mount();
    return () => intentFence.unmount();
  }, []);

  const { data: vocabulary } = useIngestionVocabulary(open);
  const themes = vocabulary?.themes ?? EMPTY_FACET_OPTIONS;
  const tags = vocabulary?.tags ?? EMPTY_FACET_OPTIONS;
  const authors = vocabulary?.authors ?? EMPTY_FACET_OPTIONS;

  const pageSize = settings.ingestion.list_page_size;
  const uploadMaxItems = settings.upload.max_items;
  const maxBytes = settings.ingestion.max_file_size_mb * 1024 * 1024;
  const maxLongEdge = settings.ingestion.max_long_edge;
  const uploadBrowserConcurrency = settings.upload.browser_concurrency;
  // 配置由页面就绪边界取得并传入；Server 接管时仍按 source_type 和当前
  // 白名单权威生成 canonical metadata。
  const importTypesKeepingOriginalLink = settings.import.keep_original_link;
  const keepOriginalLinkForUrlImports = importTypesKeepingOriginalLink.includes("url");
  const autoImportAfterParse = settings.import.auto_import;
  const importMaxItems = settings.import.max_items;
  const weiboMaxItems = settings.weibo.max_items;
  const { data: storageData } = useStorageOptions();
  const storageBackends = useMemo(() => storageData?.backends ?? [], [storageData?.backends]);
  const defaultBackend = storageBackends.find((backend) => backend.is_default)?.slug ?? "";
  const [backendChoice, setBackendChoice] = useState("");
  const activeBackend = backendChoice || defaultBackend;
  const backendOptions = useMemo(
    () => storageBackends
      .filter((backend) => backend.enabled)
      .map((backend) => ({ value: backend.slug, label: backend.display_name || storageBackendLabel(backend.slug) })),
    [storageBackends]
  );
  const resolveStorageName = useMemo(
    () => storageNameResolver(storageBackends),
    [storageBackends]
  );
  const storageName = useCallback(
    (slug: string) => resolveStorageName({ storage_slug: slug }),
    [resolveStorageName]
  );

  const uploadOwner = useUploadQueueOwner({
    pageSize,
    displayed: open && mode === "upload",
    defaults,
    storageSlug: activeBackend,
    maxItems: uploadMaxItems,
    maxBytes,
    maxLongEdge,
    browserConcurrency: uploadBrowserConcurrency,
    onDone
  });
  const importOwner = useImportQueueOwner({
    pageSize,
    displayed: open && mode === "import",
    defaults,
    keepOriginalLinkForUrlImports,
    storageSlug: activeBackend,
    onDone
  });
  const uploadQueue = uploadOwner.queue;
  const importQueue = importOwner.queue;
  const queue = mode === "upload" ? uploadQueue : importQueue;
  const {
    addFiles,
    cancel: cancelUpload,
    cancelMany: cancelManyUploads,
    retry: retryUpload
  } = uploadOwner;
  const {
    addUrls,
    addParsedImports,
    cancel: cancelImport,
    cancelMany: cancelManyImports,
    retry: retryImport
  } = importOwner;
  const uploadCommit = uploadOwner.commit;
  const importCommit = importOwner.commit;
  const commitJobs = mode === "upload"
    ? uploadCommit.commit
    : importCommit.commit;
  const confirmIngestionDuplicate = mode === "upload"
    ? uploadCommit.confirmDuplicate
    : importCommit.confirmDuplicate;
  const commitBusy = mode === "upload"
    ? uploadCommit.busy
    : importCommit.busy;
  const cancelJob = useCallback(async (job: IngestionJob) => {
    const outcome = job.kind === "upload"
      ? await cancelUpload(job)
      : await cancelImport(job);
    if (!outcome.succeeded) return false;
    if (outcome.pair) {
      const released = queue.releaseResolvedServerJobs([{
        id: job.id,
        attemptKey: job.attemptKey,
        pair: outcome.pair,
        ...(outcome.releasedRevision !== undefined
          ? { releasedRevision: outcome.releasedRevision }
          : {}),
        ...(outcome.releasedSummary
          ? { releasedSummary: outcome.releasedSummary }
          : {})
      }]);
      if (!released.has(job.id)) {
        void queue.server.recoverAuthority().catch(() => undefined);
      }
      return released.has(job.id);
    }
    return queue.removeJob(job.id);
  }, [
    cancelImport,
    cancelUpload,
    queue.releaseResolvedServerJobs,
    queue.removeJob,
    queue.server
  ]);
  const commitUploadQueueJobs = useCallback(
    (jobs: IngestionJob[]) => uploadCommit.commit(jobs, { notifyDone: false }),
    [uploadCommit.commit]
  );
  const commitImportQueueJobs = useCallback(
    (jobs: IngestionJob[]) => importCommit.commit(jobs, { notifyDone: false }),
    [importCommit.commit]
  );
  const uploadQueueWorkflow = useIngestionQueueWorkflowActions({
    queue: uploadQueue,
    defaults,
    cancelJobs: cancelManyUploads,
    commitJobs: commitUploadQueueJobs,
    onDone
  });
  const importQueueWorkflow = useIngestionQueueWorkflowActions({
    queue: importQueue,
    defaults,
    cancelJobs: cancelManyImports,
    commitJobs: commitImportQueueJobs,
    onDone
  });
  const queueWorkflow = mode === "upload"
    ? uploadQueueWorkflow
    : importQueueWorkflow;
  const prepareCloseWorkflow = useCallback((options: Readonly<{
    skipCompletedCleanup?: boolean;
  }> = {}) => {
    intentFenceRef.current.invalidate();
    void queue.flushCompletedIngestionInvalidations().catch(() => undefined);
    if (!options.skipCompletedCleanup && queue.summary.doneJobs > 0) {
      queueWorkflow.runCleanupAction("completed");
    }
    return () => {
      if (activation) onActivationSettled(activation.sequence);
      setOpen(false);
      setSourceDialogOpen(false);
      setSourceDialogPending(false);
    };
  }, [
    activation,
    onActivationSettled,
    queue.flushCompletedIngestionInvalidations,
    queue.summary.doneJobs,
    queueWorkflow.runCleanupAction
  ]);
  const closeWorkflow = useCallback((options: Readonly<{
    skipCompletedCleanup?: boolean;
  }> = {}) => {
    prepareCloseWorkflow(options)();
  }, [prepareCloseWorkflow]);

  const openInMode = async (
    next: "upload" | "import",
    opener: HTMLElement | undefined,
    intent: number
  ) => {
    if (!intentFenceRef.current.isCurrent(intent)) return false;
    if (opener) workflowReturnFocusRef.current = opener;
    setMode(next);
    setOpen(true);
    return true;
  };

  const retryJob = useCallback(async (jobId: string) => {
    const current = queue.jobsRef.current.find((job) => job.id === jobId);
    if (
      !current
      || current.failureStage === "cancel"
      || !(
        ["failed", "cancelled"].includes(current.status)
        || (current.status === "finalized" && current.resultState === "error")
      )
    ) {
      return;
    }
    if (
      current.failureStage === "commit"
      || current.status === "finalized"
    ) {
      if (ingestionJobNeedsDuplicateConfirmation(current)) return;
      if (!ingestionJobCanStartCommit(current, "resume")) return;
      await commitJobs([current]);
      return;
    }
    if (current.kind === "upload") await retryUpload(current);
    else await retryImport(current);
  }, [
    commitJobs,
    queue.jobsRef,
    retryImport,
    retryUpload
  ]);

  const removeJob = useCallback(async (job: IngestionJob) => {
    if (!ingestionJobCanBeRemovedLocally(job)) return;
    if (["done", "cancelled"].includes(job.status)) {
      queue.removeJob(job.id);
      return;
    }
    if (ingestionJobCanBeCancelled(job)) await cancelJob(job);
  }, [cancelJob, queue.removeJob]);

  const openImportSource = async (
    sourceMode: ImportSourceMode,
    opener?: HTMLElement,
    intent = intentFenceRef.current.begin()
  ) => {
    if (!intentFenceRef.current.isCurrent(intent)) return false;
    setSourceDialogPending(true);
    try {
      const module = await loadImportSourceModule();
      if (!intentFenceRef.current.isCurrent(intent)) return false;
      setImportSourceDialogComponent(() => module.ImportSourceDialog);
      setImportSourceMode(sourceMode);
      if (!await openInMode("import", opener, intent)) return false;
      if (!intentFenceRef.current.isCurrent(intent)) return false;
      setSourceDialogOpen(true);
      return true;
    } catch (error) {
      if (intentFenceRef.current.isCurrent(intent)) onLoadError(error);
      return false;
    } finally {
      if (intentFenceRef.current.isCurrent(intent)) {
        setSourceDialogPending(false);
      }
    }
  };
  const preloadImportSource = () => {
    void loadImportSourceModule().catch(() => undefined);
  };

  useLayoutEffect(() => {
    if (!open || !activation) return;
    // The workflow DialogFrame is now committed in the same tree. Its layout
    // effect owns the page-level inert/focus/scroll boundary before paint, so
    // the launcher's root-lock lease can be handed off without an interactive gap.
    onActivationOpened(activation.sequence);
  }, [activation, onActivationOpened, open]);

  useEffect(() => {
    if (!activationEnabled || !activation) {
      intentFenceRef.current.invalidate();
      setSourceDialogPending(false);
      return;
    }
    if (activation.sequence === processedActivationRef.current) {
      return;
    }
    processedActivationRef.current = activation.sequence;
    const intent = intentFenceRef.current.begin();
    const runActivation = async () => {
      let opened = false;
      try {
        if (activation.kind === "workflow") {
          setSourceDialogOpen(false);
          setSourceDialogPending(false);
          opened = await openInMode("import", activation.opener, intent);
          return;
        }
        if (activation.kind === "files") {
          setSourceDialogOpen(false);
          setSourceDialogPending(false);
          opened = await openInMode("upload", activation.opener, intent);
          return;
        }
        opened = await openImportSource(
          activation.kind,
          activation.opener,
          intent
        );
      } catch (error) {
        if (intentFenceRef.current.isCurrent(intent)) onLoadError(error);
      } finally {
        // 成功启动后由已挂载的 DialogFrame 接管页面交互，关闭时再退休激活意图。
        // 失败路径没有模态边界可接管，因此必须直接释放 launcher 的启动锁。
        if (!opened && intentFenceRef.current.isCurrent(intent)) {
          onActivationSettled(activation.sequence);
        }
      }
    };
    void runActivation();
  }, [activation, activationEnabled]);

  const addImportSource = (submission: ImportSourceSubmission) => {
    if (submission.mode === "urls") {
      void addUrls(submission.urls);
      return;
    }
    if (submission.mode === "weibo") {
      const postErrors: ImportManifestParseError[] = submission.result.errors.map((error) => ({
        line: error.line,
        raw: error.url,
        error: `微博解析失败：${error.error}`
      }));
      setImportParseErrors((current) => [
        ...current,
        ...postErrors,
        ...submission.result.manifest.errors
      ]);
      void addParsedImports(createManifestImportJobs(
        submission.result.manifest.items,
        defaults,
        activeBackend,
        "weibo",
        importTypesKeepingOriginalLink.includes("weibo")
      ));
      return;
    }
    setImportParseErrors((current) => [
      ...current,
      ...submission.manifest.errors
    ]);
    const jobs = createManifestImportJobs(
      submission.manifest.items,
      defaults,
      activeBackend,
      "jsonl",
      importTypesKeepingOriginalLink.includes("jsonl")
    );
    void addParsedImports(jobs);
  };

  const patchJob = useCallback((job: IngestionJob, patch: Partial<IngestionJob["draft"]>) => {
    queue.updateJobDraft(job.id, patch);
  }, [queue.updateJobDraft]);
  const requestCancelJob = useCallback((job: IngestionJob) => {
    if (ingestionJobCanBeCancelled(job)) void cancelJob(job);
  }, [cancelJob]);
  const requestRetryJob = useCallback((job: IngestionJob) => {
    void retryJob(job.id);
  }, [retryJob]);
  const requestRemoveJob = useCallback((job: IngestionJob) => {
    void removeJob(job);
  }, [removeJob]);
  const confirmDuplicateJob = useCallback((job: IngestionJob) => {
    const current = queue.jobsRef.current.find((item) => item.id === job.id);
    if (!current || !ingestionJobNeedsDuplicateConfirmation(current)) return;
    void confirmIngestionDuplicate(current.id);
  }, [confirmIngestionDuplicate, queue.jobsRef]);

  const busy = commitBusy || queue.actions.busy;

  return (
    <>
      {open && (
        <IngestionWorkflowWindow
          mode={mode}
          busy={busy}
          queue={queue}
          returnFocusRef={workflowReturnFocusRef}
          onPrepareClose={prepareCloseWorkflow}
          onClose={closeWorkflow}
          defaults={defaults}
          onDefaultsChange={setDefaults}
          themes={themes}
          tags={tags}
          authors={authors}
          importParseErrors={mode === "import" ? importParseErrors : []}
          onClearImportParseErrors={() => setImportParseErrors([])}
          storageName={storageName}
          onAddFiles={(files) => void addFiles(files)}
          onPatchJob={patchJob}
          onCancelJob={requestCancelJob}
          onRetryJob={requestRetryJob}
          onRemoveJob={requestRemoveJob}
          onConfirmDuplicateJob={confirmDuplicateJob}
          onApplyDefaults={queueWorkflow.applyDefaultsToQueue}
          onCleanupAction={queueWorkflow.runCleanupAction}
          onArmCleanupAction={queueWorkflow.armCleanupAction}
          onConfirmCleanupAction={queueWorkflow.confirmCleanupAction}
          onDiscardUnconfirmedIntents={queueWorkflow.discardUnconfirmedIntents}
          confirmationScope={queueWorkflow.confirmationScope}
          onArmClearQueue={queueWorkflow.armClearQueue}
          onConfirmClearQueue={queueWorkflow.confirmClearQueue}
          activeBackend={activeBackend}
          backendOptions={backendOptions}
          onBackendChange={setBackendChoice}
          onCommitReady={queueWorkflow.commitReadyJobs}
          sourceDialogPending={sourceDialogPending}
          sourceDialogOpen={sourceDialogOpen}
          sourceDialogComponent={ImportSourceDialogComponent}
          importSourceMode={importSourceMode}
          autoImportAfterParse={autoImportAfterParse}
          importMaxItems={importMaxItems}
          weiboMaxItems={weiboMaxItems}
          onOpenImportSource={(sourceMode) => {
            void openImportSource(sourceMode);
          }}
          onPreloadImportSource={preloadImportSource}
          onCloseImportSource={() => setSourceDialogOpen(false)}
          onSubmitImportSource={addImportSource}
        />
      )}
    </>
  );
}
