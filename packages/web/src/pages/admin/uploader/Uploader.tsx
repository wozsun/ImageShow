import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAdminSettings } from "../../../lib/api/admin-settings.js";
import { storageBackendLabel } from "../../../lib/ui/select-options.js";
import { useImportVocabulary } from "../../../lib/api/import-vocabulary.js";
import {
  storageNameResolver,
  useStorageOptions
} from "../../../lib/api/storage-options.js";
import type { FacetOption, ImportJob } from "../../../lib/types.js";
import type { ImportAttributeDefaults } from "../../../lib/upload/upload-utils.js";
import { importJobNeedsDuplicateConfirmation } from "./duplicate-match.js";
import {
  importJobCanBeCancelled,
  importJobCanBeRemovedLocally,
  importJobCanStartCommit
} from "./import-queue-state.js";
import type {
  ImportSourceMode,
  ImportSourceSubmission
} from "./link-import/ImportSourceDialog.js";
import { jsonlImportJobs } from "./link-import/jsonl-jobs.js";
import { weiboImportJobs } from "./link-import/weibo-jobs.js";
import type { JsonlManifestParseError } from "./import-api.js";
import {
  useImportQueueOwner,
  useUploadQueueOwner
} from "./useImportQueueOwners.js";
import { useImportQueueWorkflowActions } from "./useImportQueueWorkflowActions.js";
import { AsyncIntentFence } from "../../../lib/async-intent-fence.js";
import { UploadWorkflowWindow } from "./UploadWorkflowWindow.js";
import {
  type UploaderActivation
} from "./uploader-activation.js";
import "../../../styles/admin/image-workflow.css";
import "../../../styles/admin/upload.css";

const EMPTY_FACET_OPTIONS: FacetOption[] = [];
type ImportSourceDialogModule =
  typeof import("./link-import/ImportSourceDialog.js");

export function Uploader({
  activation,
  activationEnabled,
  loadImportSourceModule,
  onActivationSettled,
  onDone,
  onLoadError
}: {
  activation: UploaderActivation | null;
  activationEnabled: boolean;
  loadImportSourceModule: () => Promise<ImportSourceDialogModule>;
  onActivationSettled: (sequence: number) => void;
  onDone: () => void;
  onLoadError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"file" | "link">("file");
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [sourceDialogPending, setSourceDialogPending] = useState(false);
  const [ImportSourceDialogComponent, setImportSourceDialogComponent] =
    useState<ImportSourceDialogModule["ImportSourceDialog"] | null>(null);
  const [importSourceMode, setImportSourceMode] =
    useState<ImportSourceMode>("urls");
  const [jsonlErrors, setJsonlErrors] = useState<JsonlManifestParseError[]>([]);
  const [defaults, setDefaults] = useState<ImportAttributeDefaults>({
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

  const { data: settingsData } = useAdminSettings();
  const { data: vocabulary } = useImportVocabulary(open);
  const themes = vocabulary?.themes ?? EMPTY_FACET_OPTIONS;
  const tags = vocabulary?.tags ?? EMPTY_FACET_OPTIONS;
  const authors = vocabulary?.authors ?? EMPTY_FACET_OPTIONS;

  const pageSize = settingsData?.settings.upload.list_page_size ?? 20;
  const uploadMaxItems = settingsData?.settings.upload.max_items ?? 200;
  const maxBytes = (settingsData?.settings.upload.max_file_size_mb ?? 100) * 1024 * 1024;
  const maxLongEdge = settingsData?.settings.upload.max_long_edge ?? 32000;
  const uploadConcurrency = settingsData?.settings.upload.concurrency ?? 2;
  const fillOriginalUrl = settingsData?.settings.link_image.fill_original_url ?? false;
  const autoImportAfterParse =
    settingsData?.settings.link_image.auto_import === true;
  const linkMaxItems = settingsData?.settings.link_image.max_items ?? 200;
  const weiboMaxItems = settingsData?.settings.weibo.max_items ?? 20;
  const { data: storageData } = useStorageOptions();
  const storageBackends = useMemo(() => storageData?.backends ?? [], [storageData?.backends]);
  const defaultBackend = storageBackends.find((backend) => backend.is_default)?.slug ?? "local";
  const [backendChoice, setBackendChoice] = useState("");
  const activeBackend = backendChoice || defaultBackend;
  const backendOptions = useMemo(
    () => (storageBackends.length ? storageBackends : [{
      slug: "local",
      display_name: storageBackendLabel("local"),
      enabled: true,
      is_default: true
    }])
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
    displayed: open && mode === "file",
    defaults,
    storageSlug: activeBackend,
    maxItems: uploadMaxItems,
    maxBytes,
    maxLongEdge,
    concurrency: uploadConcurrency,
    onDone
  });
  const importOwner = useImportQueueOwner({
    pageSize,
    displayed: open && mode === "link",
    defaults,
    fillOriginalUrl,
    storageSlug: activeBackend,
    onDone
  });
  const uploadQueue = uploadOwner.queue;
  const importQueue = importOwner.queue;
  const queue = mode === "file" ? uploadQueue : importQueue;
  const {
    addFiles,
    cancel: cancelLocalImport,
    cancelMany: cancelManyLocalImports,
    retry: retryLocalImport
  } = uploadOwner;
  const {
    addUrls,
    addJobs,
    addWeiboJobs,
    cancel: cancelLinkImport,
    cancelMany: cancelManyLinkImports,
    retry: retryLinkImport
  } = importOwner;
  const uploadCommit = uploadOwner.commit;
  const importCommit = importOwner.commit;
  const commitImports = mode === "file"
    ? uploadCommit.commit
    : importCommit.commit;
  const confirmImportDuplicate = mode === "file"
    ? uploadCommit.confirmDuplicate
    : importCommit.confirmDuplicate;
  const commitBusy = mode === "file"
    ? uploadCommit.busy
    : importCommit.busy;
  const cancelJob = useCallback(async (job: ImportJob) => {
    const outcome = job.kind === "local"
      ? await cancelLocalImport(job)
      : await cancelLinkImport(job);
    if (!outcome.succeeded) return false;
    if (outcome.pair) {
      const released = queue.releaseResolvedServerJobs([{
        id: job.id,
        attemptKey: job.attemptKey,
        pair: outcome.pair
      }]);
      if (!released.has(job.id)) queue.server.refresh();
      return released.has(job.id);
    }
    return queue.removeJob(job.id);
  }, [
    cancelLinkImport,
    cancelLocalImport,
    queue.releaseResolvedServerJobs,
    queue.removeJob,
    queue.server
  ]);
  const commitUploadQueueJobs = useCallback(
    (jobs: ImportJob[]) => uploadCommit.commit(jobs, { notifyDone: false }),
    [uploadCommit.commit]
  );
  const commitImportQueueJobs = useCallback(
    (jobs: ImportJob[]) => importCommit.commit(jobs, { notifyDone: false }),
    [importCommit.commit]
  );
  const uploadQueueWorkflow = useImportQueueWorkflowActions({
    queue: uploadQueue,
    defaults,
    cancelJobs: cancelManyLocalImports,
    commitJobs: commitUploadQueueJobs,
    onDone
  });
  const importQueueWorkflow = useImportQueueWorkflowActions({
    queue: importQueue,
    defaults,
    cancelJobs: cancelManyLinkImports,
    commitJobs: commitImportQueueJobs,
    onDone
  });
  const queueWorkflow = mode === "file"
    ? uploadQueueWorkflow
    : importQueueWorkflow;
  const closeWorkflow = useCallback((options: Readonly<{
    skipCompletedCleanup?: boolean;
  }> = {}) => {
    intentFenceRef.current.invalidate();
    void queue.flushCompletedImportInvalidations().catch(() => undefined);
    if (!options.skipCompletedCleanup && queue.summary.doneJobs > 0) {
      queueWorkflow.runCleanupAction("completed");
    }
    if (activation) onActivationSettled(activation.sequence);
    setOpen(false);
    setSourceDialogOpen(false);
    setSourceDialogPending(false);
  }, [
    activation,
    onActivationSettled,
    queue.flushCompletedImportInvalidations,
    queue.summary.doneJobs,
    queueWorkflow.runCleanupAction
  ]);

  const openInMode = async (
    next: "file" | "link",
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
      if (importJobNeedsDuplicateConfirmation(current)) return;
      if (!importJobCanStartCommit(current, "resume")) return;
      await commitImports([current]);
      return;
    }
    if (current.kind === "local") await retryLocalImport(current);
    else await retryLinkImport(current);
  }, [
    commitImports,
    queue.jobsRef,
    retryLinkImport,
    retryLocalImport
  ]);

  const removeJob = useCallback(async (job: ImportJob) => {
    if (!importJobCanBeRemovedLocally(job)) return;
    if (["done", "cancelled"].includes(job.status)) {
      queue.removeJob(job.id);
      return;
    }
    if (importJobCanBeCancelled(job)) await cancelJob(job);
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
      if (!await openInMode("link", opener, intent)) return false;
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
          opened = await openInMode("link", activation.opener, intent);
          return;
        }
        if (activation.kind === "files") {
          setSourceDialogOpen(false);
          setSourceDialogPending(false);
          opened = await openInMode("file", activation.opener, intent);
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
        // 成功启动后由 closeWorkflow 统一释放激活锁。若在弹窗打开时提前释放，
        // 图片页会短暂经历 disabled -> enabled，从而在来源模块慢加载时产生闪烁。
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
      const postErrors: JsonlManifestParseError[] = submission.result.errors.map((error) => ({
        line: error.line,
        raw: error.url,
        error: `微博解析失败：${error.error}`
      }));
      setJsonlErrors((current) => [
        ...current,
        ...postErrors,
        ...submission.result.manifest.errors
      ]);
      void addWeiboJobs(weiboImportJobs(
        submission.result.manifest.items,
        defaults,
        activeBackend
      ));
      return;
    }
    setJsonlErrors((current) => [...current, ...submission.manifest.errors]);
    const jobs = jsonlImportJobs(
      submission.manifest.items,
      defaults,
      activeBackend
    );
    void addJobs(jobs);
  };

  const patchJob = useCallback((job: ImportJob, patch: Partial<ImportJob["draft"]>) => {
    queue.updateJobDraft(job.id, patch);
  }, [queue.updateJobDraft]);
  const requestCancelJob = useCallback((job: ImportJob) => {
    if (importJobCanBeCancelled(job)) void cancelJob(job);
  }, [cancelJob]);
  const requestRetryJob = useCallback((job: ImportJob) => {
    void retryJob(job.id);
  }, [retryJob]);
  const requestRemoveJob = useCallback((job: ImportJob) => {
    void removeJob(job);
  }, [removeJob]);
  const confirmDuplicateJob = useCallback((job: ImportJob) => {
    const current = queue.jobsRef.current.find((item) => item.id === job.id);
    if (!current || !importJobNeedsDuplicateConfirmation(current)) return;
    void confirmImportDuplicate(current.id);
  }, [confirmImportDuplicate, queue.jobsRef]);

  const busy = commitBusy || queue.actions.busy;

  return (
    <>
      {open && (
        <UploadWorkflowWindow
          mode={mode}
          busy={busy}
          queue={queue}
          returnFocusRef={workflowReturnFocusRef}
          onClose={closeWorkflow}
          defaults={defaults}
          onDefaultsChange={setDefaults}
          themes={themes}
          tags={tags}
          authors={authors}
          jsonlErrors={mode === "link" ? jsonlErrors : []}
          onClearJsonlErrors={() => setJsonlErrors([])}
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
          linkMaxItems={linkMaxItems}
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
