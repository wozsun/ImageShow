import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api/client.js";
import { useAnimatedClose } from "../../../hooks/useAnimatedClose.js";
import { useBodyScrollLock } from "../../../hooks/useBodyScrollLock.js";
import { useDialogFocus } from "../../../hooks/useDialogFocus.js";
import { adminApiBasePath } from "../../../lib/constants.js";
import { queryKeys } from "../../../lib/api/query-keys.js";
import { facetDisplayName } from "../../../lib/ui/formatters.js";
import { storageBackendLabel, uploadCommonBrightnessOptions, uploadCommonDeviceOptions } from "../../../lib/ui/select-options.js";
import { useImportVocabulary } from "../../../lib/api/import-vocabulary.js";
import { useStorageOptions } from "../../../lib/api/storage-options.js";
import type { AdminSettings, FacetOption, ImageItem, ImportJob } from "../../../lib/types.js";
import type { ImportAttributeDefaults } from "../../../lib/upload/upload-utils.js";
import type { ImportPreviewTarget } from "./DuplicateMatchPanel.js";
import type { LinkDialogSubmission, LinkInputMode } from "./link-import/LinkUrlDialog.js";
import { jsonlImportJobs } from "./link-import/jsonl-jobs.js";
import { weiboImportJobs } from "./link-import/weibo-jobs.js";
import type { JsonlManifestParseError } from "./import-api.js";
import { useImportQueue } from "./useImportQueue.js";
import { useLocalUploadImport } from "./useLocalUploadImport.js";
import { useLinkImport } from "./link-import/useLinkImport.js";
import { useImportCommit } from "./useImportCommit.js";
import { useImportStatusEvents } from "./useImportStatusEvents.js";
import type { UploadCleanupAction } from "./UploadCleanupMenu.js";
import { canApplyImportAttributeDefaults } from "./import-attribute-policy.js";
import { UploaderTriggers } from "./UploaderTriggers.js";
import { UploadWorkflowWindow } from "./UploadWorkflowWindow.js";

const EMPTY_FACET_OPTIONS: FacetOption[] = [];

function isCompletedImportJob(job: ImportJob) {
  return job.status === "done" || job.status === "skipped";
}

function needsImportCancellation(job: ImportJob) {
  return job.status !== "cancelling"
    && job.status !== "done"
    && job.status !== "skipped"
    && job.status !== "cancelled";
}

export function Uploader({ onDone }: { onDone: () => void }) {
  const fileInputId = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"file" | "link">("file");
  const [urlInputOpen, setUrlInputOpen] = useState(false);
  const [linkInputMode, setLinkInputMode] = useState<LinkInputMode>("urls");
  const [jsonlErrors, setJsonlErrors] = useState<JsonlManifestParseError[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [defaults, setDefaults] = useState<ImportAttributeDefaults>({
    device: "auto",
    brightness: "auto",
    theme: "",
    author: "",
    tags: []
  });
  const [defaultsExpanded, setDefaultsExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detailItem, setDetailItem] = useState<ImageItem | null>(null);
  const [preview, setPreview] = useState<ImportPreviewTarget | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const linkPickerRef = useRef<HTMLButtonElement | null>(null);
  const workflowReturnFocusRef = useRef<HTMLElement | null>(null);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);

  const { data: settingsData } = useQuery<{ settings: AdminSettings }>({ queryKey: queryKeys.settings, queryFn: ({ signal }) => api(`${adminApiBasePath}/settings`, { signal }) });
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
  const storageNameBySlug = useMemo(
    () => new Map(backendOptions.map((backend) => [backend.value, backend.label] as const)),
    [backendOptions]
  );
  const storageName = useCallback(
    (slug: string) => storageNameBySlug.get(slug) || storageBackendLabel(slug),
    [storageNameBySlug]
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
  const commitImports = useImportCommit({ updateJob: queue.updateJob, concurrency: commitConcurrency, onDone });
  useImportStatusEvents(queue.jobs, queue.jobsRef, queue.updateJob);

  const exit = useAnimatedClose(() => {
    setOpen(false);
    setDefaultsExpanded(false);
    queue.clearJobs(isCompletedImportJob);
    setJsonlErrors([]);
  });
  useBodyScrollLock(open);
  useDialogFocus({
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    returnFocusRef: workflowReturnFocusRef,
    onEscape: () => exit.requestClose(),
    active: open,
    paused: Boolean(detailItem || preview || urlInputOpen),
  });

  const cancelJob = useCallback(async (job: ImportJob) => {
    const cancellationSucceeded = job.kind === "local"
      ? await cancelLocalImport(job)
      : await cancelLinkImport(job);
    if (cancellationSucceeded) queue.removeJob(job.id);
    return cancellationSucceeded;
  }, [cancelLinkImport, cancelLocalImport, queue.removeJob]);

  const openInMode = async (next: "file" | "link", opener?: HTMLElement) => {
    if (opener) workflowReturnFocusRef.current = opener;
    const discarded = queue.jobsRef.current.filter((job) => next === "file" ? job.kind !== "local" : job.kind === "local");
    await Promise.all(discarded.filter(needsImportCancellation).map(cancelJob));
    queue.retainMode(next);
    setMode(next);
    setOpen(true);
  };

  const retryJob = useCallback(async (job: ImportJob) => {
    if (job.failureStage === "commit") {
      queue.releasePreparedMd5(job.id);
      if (job.md5) {
        const claim = queue.claimPreparedMd5(job.id, job.md5);
        if (!claim.claimed) {
          queue.updateJob(job.id, {
            status: "failed",
            failureStage: "commit",
            message: "同批相同图片已由其他任务占用，请稍后重试"
          });
          return;
        }
      }
      setBusy(true);
      await commitImports([job]).finally(() => setBusy(false));
      return;
    }
    if (job.kind === "local") await retryLocalImport(job);
    else await retryLinkImport(job);
  }, [
    commitImports,
    queue.claimPreparedMd5,
    queue.releasePreparedMd5,
    queue.updateJob,
    retryLinkImport,
    retryLocalImport
  ]);

  const removeJob = useCallback(async (job: ImportJob) => {
    if (["done", "skipped", "cancelled"].includes(job.status)) {
      queue.removeJob(job.id);
      return;
    }
    await cancelJob(job);
  }, [cancelJob, queue.removeJob]);

  const clearJobs = async (predicate: (job: ImportJob) => boolean) => {
    const targets = queue.jobsRef.current.filter(predicate);
    // cancelJob 会先把任务改成 cancelling。固定本次 ID，避免取消完成后再次按旧状态条件
    // 筛选，导致“重复待确认”任务找不到而仍留在总数中；期间新产生的重复项也不会误删。
    const targetIds = new Set(targets.map((job) => job.id));
    const cancellationRequests = targets
      .filter(needsImportCancellation)
      .map(cancelJob);
    // 取消函数在首个 await 前已经中止活动请求并标记任务；服务端暂存对象清理可能较慢，
    // 不应阻塞用户明确要求的本地队列清理和总数更新。
    queue.clearJobIds(targetIds);
    await Promise.allSettled(cancellationRequests);
  };

  const openLinkInput = async (inputMode: LinkInputMode, opener?: HTMLElement) => {
    setLinkInputMode(inputMode);
    await openInMode("link", opener);
    setUrlInputOpen(true);
  };

  const addLinks = (submission: LinkDialogSubmission) => {
    if (submission.inputMode === "urls") {
      void addUrls(submission.urls);
      return;
    }
    if (submission.inputMode === "weibo") {
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

  const {
    readyJobs,
    duplicateJobs,
    doneJobs,
    skippedJobs
  } = queue.summary;
  const completedJobs = doneJobs + skippedJobs;
  const cleanupActions: UploadCleanupAction[] = [
    {
      id: "duplicates",
      label: "清空重复待确认",
      enabled: duplicateJobs > 0,
      run: () => void clearJobs((job) => job.status === "ready" && job.duplicateDecision === "undecided"),
    },
    {
      id: "uncommitted",
      label: "清空未提交",
      enabled: queue.jobs.length > completedJobs,
      run: () => void clearJobs((job) => !isCompletedImportJob(job)),
    },
    {
      id: "completed",
      label: "清空已完成",
      enabled: completedJobs > 0,
      run: () => void clearJobs(isCompletedImportJob),
    },
  ];
  const defaultsSummary = [
    uploadCommonDeviceOptions.find((option) => option.value === defaults.device)?.label ?? "设备不设",
    uploadCommonBrightnessOptions.find((option) => option.value === defaults.brightness)?.label ?? "亮暗不设",
    facetDisplayName(themes, defaults.theme, "主题不设"),
    facetDisplayName(authors, defaults.author, "作者不设"),
    `${defaults.tags.length} 个标签`,
  ].join(" · ");
  const canApplyDefaults = useMemo(
    () => queue.jobs.some((job) => canApplyImportAttributeDefaults(job, defaults)),
    [defaults, queue.jobs]
  );
  const patchJob = useCallback((job: ImportJob, patch: Partial<ImportJob["draft"]>) => {
    queue.updateJobDraft(job.id, patch);
  }, [queue.updateJobDraft]);
  const requestCancelJob = useCallback((job: ImportJob) => {
    void cancelJob(job);
  }, [cancelJob]);
  const requestRetryJob = useCallback((job: ImportJob) => {
    void retryJob(job);
  }, [retryJob]);
  const requestRemoveJob = useCallback((job: ImportJob) => {
    void removeJob(job);
  }, [removeJob]);
  const confirmDuplicateJob = useCallback((job: ImportJob) => {
    queue.updateJob(job.id, { duplicateDecision: "upload", message: "已确认提交副本" });
  }, [queue.updateJob]);
  const openJobDetail = useCallback((item: ImageItem, opener: HTMLElement) => {
    detailReturnFocusRef.current = opener;
    setDetailItem(item);
  }, []);
  const openJobPreview = useCallback((target: ImportPreviewTarget) => {
    previewReturnFocusRef.current = target.opener ?? null;
    setPreview(target);
  }, []);

  return (
    <>
      <UploaderTriggers
        onOpenWorkflow={(opener) => void openInMode("link", opener)}
        onOpenUrls={(opener) => void openLinkInput("urls", opener)}
        onOpenJsonl={(opener) => void openLinkInput("jsonl", opener)}
        onOpenWeibo={(opener) => void openLinkInput("weibo", opener)}
        onOpenFiles={(opener) => void openInMode("file", opener)}
      />
      {open && (
        <UploadWorkflowWindow
          mode={mode}
          fileInputId={fileInputId}
          closing={exit.closing}
          onAnimationEnd={exit.onAnimationEnd}
          dialogRef={dialogRef}
          listRef={listRef}
          closeButtonRef={closeButtonRef}
          fileInputRef={fileInputRef}
          linkPickerRef={linkPickerRef}
          busy={busy}
          queue={queue}
          jsonlErrors={jsonlErrors}
          cleanupActions={cleanupActions}
          defaults={defaults}
          defaultsExpanded={defaultsExpanded}
          defaultsSummary={defaultsSummary}
          canApplyDefaults={canApplyDefaults}
          themes={themes}
          tags={tags}
          authors={authors}
          storageName={storageName}
          activeBackend={activeBackend}
          backendOptions={backendOptions}
          dragOver={dragOver}
          detailItem={detailItem}
          detailReturnFocusRef={detailReturnFocusRef}
          preview={preview}
          previewReturnFocusRef={previewReturnFocusRef}
          urlInputOpen={urlInputOpen}
          linkInputMode={linkInputMode}
          linkMaxItems={linkMaxItems}
          weiboMaxItems={weiboMaxItems}
          onRequestClose={() => exit.requestClose()}
          onAddFiles={(files) => void addFiles(files)}
          onClearJsonlErrors={() => setJsonlErrors([])}
          onDefaultsChange={setDefaults}
          onDefaultsExpandedChange={setDefaultsExpanded}
          onDragOverChange={setDragOver}
          onPatchJob={patchJob}
          onCancelJob={requestCancelJob}
          onRetryJob={requestRetryJob}
          onRemoveJob={requestRemoveJob}
          onConfirmDuplicateJob={confirmDuplicateJob}
          onOpenDetail={openJobDetail}
          onOpenPreview={openJobPreview}
          onOpenLinkInput={(inputMode) => {
            setLinkInputMode(inputMode);
            setUrlInputOpen(true);
          }}
          onBackendChange={setBackendChoice}
          onCancelAndClose={() => {
            void clearJobs(() => true).then(() => exit.requestClose());
          }}
          onCommitReady={() => {
            setBusy(true);
            void commitImports(readyJobs).finally(() => setBusy(false));
          }}
          onCloseDetail={() => setDetailItem(null)}
          onClosePreview={() => setPreview(null)}
          onCloseLinkInput={() => setUrlInputOpen(false)}
          onSubmitLinks={addLinks}
        />
      )}
    </>
  );
}
