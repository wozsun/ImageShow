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
  importJobCanLeaveQueue,
  importJobCanStartCommit,
  summarizeImportJobs
} from "./import-queue-state.js";
import type {
  ImportSourceMode,
  ImportSourceSubmission
} from "./link-import/ImportSourceDialog.js";
import { jsonlImportJobs } from "./link-import/jsonl-jobs.js";
import { weiboImportJobs } from "./link-import/weibo-jobs.js";
import type { JsonlManifestParseError } from "./import-api.js";
import { useImportQueue } from "./useImportQueue.js";
import { useLocalUploadImport } from "./useLocalUploadImport.js";
import { useLinkImport } from "./link-import/useLinkImport.js";
import { useImportCommit } from "./useImportCommit.js";
import { useImportStatusEvents } from "./useImportStatusEvents.js";
import {
  isCompletedImportJob
} from "./upload-cleanup-actions.js";
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
  const uploadConcurrency = settingsData?.settings.upload.concurrency ?? 2;
  const downloadConcurrency = settingsData?.settings.link_image.concurrency ?? 2;
  const commitConcurrency = settingsData?.settings.import.commit_concurrency ?? 5;
  const fillOriginalUrl = settingsData?.settings.link_image.fill_original_url ?? false;
  const autoImportAfterParse =
    settingsData?.settings.link_image.auto_import === true;
  const linkMaxItems = settingsData?.settings.link_image.max_items ?? 200;
  const weiboMaxItems = settingsData?.settings.weibo.max_items ?? 20;
  const queue = useImportQueue(pageSize);

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

  const {
    addFiles,
    cancel: cancelLocalImport,
    retry: retryLocalImport
  } = useLocalUploadImport({
    queue: queue.workerApi,
    defaults,
    storageSlug: activeBackend,
    maxItems: uploadMaxItems,
    maxBytes,
    concurrency: uploadConcurrency
  });
  const {
    addUrls,
    addJobs,
    addWeiboJobs,
    cancel: cancelLinkImport,
    retry: retryLinkImport
  } = useLinkImport({
    queue: queue.workerApi,
    defaults,
    fillOriginalUrl,
    storageSlug: activeBackend,
    concurrency: downloadConcurrency
  });
  const {
    commit: commitImports,
    confirmDuplicate: confirmImportDuplicate,
    busy
  } = useImportCommit({
    jobsRef: queue.jobsRef,
    updateJob: queue.updateJob,
    updateJobs: queue.updateJobs,
    completeJob: queue.completeJob,
    concurrency: commitConcurrency,
    onDone
  });
  useImportStatusEvents(open, queue.jobs, queue.jobsRef, queue.updateJob);

  const closeWorkflow = () => {
    intentFenceRef.current.invalidate();
    if (activation) onActivationSettled(activation.sequence);
    setOpen(false);
    setSourceDialogOpen(false);
    setSourceDialogPending(false);
    queue.clearJobs(isCompletedImportJob);
    setJsonlErrors([]);
  };

  const cancelJob = useCallback(async (job: ImportJob) => {
    const cancellationSucceeded = job.kind === "local"
      ? await cancelLocalImport(job)
      : await cancelLinkImport(job);
    if (cancellationSucceeded) queue.removeJob(job.id);
    return cancellationSucceeded;
  }, [cancelLinkImport, cancelLocalImport, queue.removeJob]);

  const openInMode = async (
    next: "file" | "link",
    opener: HTMLElement | undefined,
    intent: number
  ) => {
    if (!intentFenceRef.current.isCurrent(intent)) return false;
    if (opener) workflowReturnFocusRef.current = opener;
    const discarded = queue.jobsRef.current.filter((job) => next === "file" ? job.kind !== "local" : job.kind === "local");
    await Promise.all(discarded.filter(importJobCanBeCancelled).map(cancelJob));
    if (!intentFenceRef.current.isCurrent(intent)) return false;
    queue.retainMode(next);
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
    if (!importJobCanLeaveQueue(job)) return;
    if (["done", "cancelled"].includes(job.status)) {
      queue.removeJob(job.id);
      return;
    }
    if (importJobCanBeCancelled(job)) await cancelJob(job);
  }, [cancelJob, queue.removeJob]);

  const clearJobs = async (predicate: (job: ImportJob) => boolean) => {
    const targets = queue.jobsRef.current
      .filter(predicate)
      .filter(importJobCanLeaveQueue);
    // cancelJob 会先把任务改成 cancelling。固定本次 ID，避免取消完成后再次按旧状态条件
    // 筛选，导致“重复待确认”任务找不到而仍留在总数中；期间新产生的重复项也不会误删。
    const targetIds = new Set(targets.map((job) => job.id));
    const cancellationRequests = targets
      .filter(importJobCanBeCancelled)
      .map(cancelJob);
    // 取消函数在首个 await 前已经中止活动请求并标记任务；服务端暂存对象清理可能较慢，
    // 不应阻塞用户明确要求的本地队列清理和总数更新。
    queue.clearJobIds(targetIds);
    await Promise.allSettled(cancellationRequests);
  };

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

  const commitReadyJobs = () => {
    const currentReadyJobs = summarizeImportJobs(
      queue.jobsRef.current
    ).readyJobs;
    if (!currentReadyJobs.length) return;
    void commitImports(currentReadyJobs);
  };

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
          jsonlErrors={jsonlErrors}
          onClearJsonlErrors={() => setJsonlErrors([])}
          storageName={storageName}
          onAddFiles={(files) => void addFiles(files)}
          onPatchJob={patchJob}
          onCancelJob={requestCancelJob}
          onRetryJob={requestRetryJob}
          onRemoveJob={requestRemoveJob}
          onConfirmDuplicateJob={confirmDuplicateJob}
          onClearJobs={clearJobs}
          activeBackend={activeBackend}
          backendOptions={backendOptions}
          onBackendChange={setBackendChoice}
          onCommitReady={commitReadyJobs}
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
