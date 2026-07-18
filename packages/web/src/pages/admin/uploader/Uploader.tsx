import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api/client.js";
import { Icon } from "../../../components/icon/Icon.js";
import { WorkflowCollapsePanel } from "../../../components/layout/WorkflowCollapsePanel.js";
import { ImageDetailModal } from "../../../components/image/ImageDetailModal.js";
import { ImagePreviewModal } from "../../../components/image/ImagePreviewModal.js";
import { AdminPagination } from "../../../components/navigation/AdminPagination.js";
import { ThemeInput } from "../../../components/form/ThemeInput.js";
import { TagInput } from "../../../components/form/TagInput.js";
import { AuthorInput } from "../../../components/form/AuthorInput.js";
import { SelectMenu } from "../../../components/form/SelectMenu.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import { useAnimatedClose } from "../../../hooks/useAnimatedClose.js";
import { useBodyScrollLock } from "../../../hooks/useBodyScrollLock.js";
import { useDialogFocus } from "../../../hooks/useDialogFocus.js";
import { adminApiBasePath, queryKeys } from "../../../lib/constants.js";
import { facetDisplayName } from "../../../lib/ui/formatters.js";
import { storageBackendLabel, uploadCommonBrightnessOptions, uploadCommonDeviceOptions } from "../../../lib/ui/select-options.js";
import { useImportVocabulary } from "../../../lib/api/import-vocabulary.js";
import { useStorageOptions } from "../../../lib/api/storage-options.js";
import type { AdminSettings, ImageItem, ImportJob } from "../../../lib/types.js";
import type { CommonImageAttributes } from "../../../lib/upload/upload-utils.js";
import { ImportJobList } from "./ImportJobList.js";
import type { ImportPreviewTarget } from "./DuplicateMatchPanel.js";
import { LinkUrlDialog, type LinkDialogSubmission, type LinkInputMode } from "./link-import/LinkUrlDialog.js";
import { LinkImportSplitButton } from "./link-import/LinkImportSplitButton.js";
import { jsonlImportJobs } from "./link-import/jsonl-jobs.js";
import { weiboImportJobs } from "./link-import/weibo-jobs.js";
import type { JsonlManifestParseError } from "./import-api.js";
import { useImportQueue } from "./useImportQueue.js";
import { useLocalUploadImport } from "./useLocalUploadImport.js";
import { useLinkImport } from "./link-import/useLinkImport.js";
import { useImportCommit } from "./useImportCommit.js";
import { useImportStatusEvents } from "./useImportStatusEvents.js";
import { UploadCleanupMenu, type UploadCleanupAction } from "./UploadCleanupMenu.js";

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
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"file" | "link">("file");
  const [urlInputOpen, setUrlInputOpen] = useState(false);
  const [linkInputMode, setLinkInputMode] = useState<LinkInputMode>("urls");
  const [jsonlErrors, setJsonlErrors] = useState<JsonlManifestParseError[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [defaults, setDefaults] = useState<CommonImageAttributes>({ device: "", brightness: "", theme: "", author: "", tags: [] });
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

  const { data: settingsData } = useQuery<{ settings: AdminSettings }>({ queryKey: queryKeys.settings, queryFn: () => api(`${adminApiBasePath}/settings`) });
  const { data: vocabulary } = useImportVocabulary(open);
  const themes = vocabulary?.themes ?? [];
  const tags = vocabulary?.tags ?? [];
  const authors = vocabulary?.authors ?? [];

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
  const storageBackends = storageData?.backends ?? [];
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
  const storageName = (slug: string) => storageNameBySlug.get(slug) || storageBackendLabel(slug);

  const queueApi = {
    jobsRef: queue.jobsRef, appendJobs: queue.appendJobs, updateJob: queue.updateJob,
    claimPreparedMd5: queue.claimPreparedMd5, releasePreparedMd5: queue.releasePreparedMd5
  };
  const localImport = useLocalUploadImport({
    queue: queueApi,
    defaults,
    storageSlug: activeBackend,
    maxItems: uploadMaxItems,
    maxBytes,
    concurrency: uploadConcurrency
  });
  const linkImport = useLinkImport({ queue: queueApi, defaults, fillOriginalUrl, storageSlug: activeBackend, concurrency: downloadConcurrency });
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

  const cancelJob = async (job: ImportJob) => {
    const cancellationSucceeded = job.kind === "local"
      ? await localImport.cancel(job)
      : await linkImport.cancel(job);
    if (cancellationSucceeded) queue.removeJob(job.id);
    return cancellationSucceeded;
  };

  const openInMode = async (next: "file" | "link", opener?: HTMLElement) => {
    if (opener) workflowReturnFocusRef.current = opener;
    const discarded = queue.jobsRef.current.filter((job) => next === "file" ? job.kind !== "local" : job.kind === "local");
    await Promise.all(discarded.filter(needsImportCancellation).map(cancelJob));
    queue.retainMode(next);
    setMode(next);
    setOpen(true);
  };

  const retryJob = async (job: ImportJob) => {
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
    if (job.kind === "local") await localImport.retry(job);
    else await linkImport.retry(job);
  };

  const removeJob = async (job: ImportJob) => {
    if (["done", "skipped", "cancelled"].includes(job.status)) {
      queue.removeJob(job.id);
      return;
    }
    await cancelJob(job);
  };

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
      void linkImport.addUrls(submission.urls, submission.mode);
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
      void linkImport.addWeiboJobs(weiboImportJobs(
        submission.result.manifest.items,
        defaults,
        submission.mode,
        activeBackend
      ));
      return;
    }
    setJsonlErrors((current) => [...current, ...submission.manifest.errors]);
    const jobs = jsonlImportJobs(submission.manifest.items, defaults, submission.mode, activeBackend);
    void linkImport.addJobs(jobs);
  };

  const readyJobs = queue.jobs.filter((job) => job.status === "ready" && job.duplicateDecision !== "undecided");
  const duplicateJobs = queue.jobs.filter((job) => job.status === "ready" && job.duplicateDecision === "undecided").length;
  const runningJobs = queue.jobs.filter((job) => ["queued", "uploading", "downloading", "processing", "committing", "cancelling"].includes(job.status)).length;
  const doneJobs = queue.jobs.filter((job) => job.status === "done").length;
  const failedJobs = queue.jobs.filter((job) => job.status === "failed").length;
  const skippedJobs = queue.jobs.filter((job) => job.status === "skipped").length;
  const modeTitle = mode === "file" ? "上传图片" : "导入图片";
  const emptySubtitle = mode === "file"
    ? "选择后立即上传并在服务端准备图片"
    : "输入来源后立即创建并准备图片任务";
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
      enabled: queue.jobs.some((job) => !isCompletedImportJob(job)),
      run: () => void clearJobs((job) => !isCompletedImportJob(job)),
    },
    {
      id: "completed",
      label: "清空已完成",
      enabled: queue.jobs.some(isCompletedImportJob),
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

  return (
    <>
      <div className="upload-triggers">
        <LinkImportSplitButton
          onOpenWorkflow={(opener) => void openInMode("link", opener)}
          onOpenUrls={(opener) => void openLinkInput("urls", opener)}
          onOpenJsonl={(opener) => void openLinkInput("jsonl", opener)}
          onOpenWeibo={(opener) => void openLinkInput("weibo", opener)}
        />
        <button className="button upload-trigger" type="button" onClick={(event) => void openInMode("file", event.currentTarget)}><Icon name="upload-cloud-2-line" />上传图片</button>
      </div>
      {open && (
        <div className={`upload-overlay ${exit.closing ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-label={modeTitle} onAnimationEnd={exit.onAnimationEnd}>
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
                  <p>{emptySubtitle}</p>
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
                    <button ref={linkPickerRef} type="button" className="button secondary upload-picker pressable" disabled={busy} onClick={() => { setLinkInputMode("urls"); setUrlInputOpen(true); }}><Icon name="download-cloud-2-line" />选择来源</button>
                  ) : (
                    <label
                      className={`button secondary upload-picker pressable${busy ? " is-disabled" : ""}`}
                      aria-disabled={busy}
                    >
                      <Icon name="upload-cloud-2-line" /><input ref={fileInputRef} type="file" accept="image/*" multiple disabled={busy} onChange={(event) => { void localImport.addFiles(event.target.files); event.target.value = ""; }} />选择图片
                    </label>
                  )}
                  <button ref={closeButtonRef} className="icon close pressable upload-close-button" type="button" title="关闭" onClick={() => exit.requestClose()} disabled={busy}><Icon name="close-line" /></button>
                </div>
              </div>
            </header>

            <WorkflowCollapsePanel
              className="upload-defaults-panel"
              contentClassName="upload-defaults"
              title="默认属性"
              summary={defaultsSummary}
              expanded={defaultsExpanded}
              onExpandedChange={setDefaultsExpanded}
            >
              <SelectMenu className="upload-default-select upload-default-device" value={defaults.device} onChange={(device) => setDefaults({ ...defaults, device })} options={uploadCommonDeviceOptions} ariaLabel="默认设备" />
              <SelectMenu className="upload-default-select upload-default-brightness" value={defaults.brightness} onChange={(brightness) => setDefaults({ ...defaults, brightness })} options={uploadCommonBrightnessOptions} ariaLabel="默认亮度" />
              <div className="upload-default-pair">
                <ThemeInput className="upload-default-theme" value={defaults.theme} onChange={(theme) => setDefaults({ ...defaults, theme })} themes={themes} placeholder="主题" ariaLabel="默认主题" />
                <AuthorInput className="upload-default-author" value={defaults.author} onChange={(author) => setDefaults({ ...defaults, author })} authors={authors} placeholder="默认作者" ariaLabel="默认作者" />
                <TagInput className="upload-default-tags" value={defaults.tags} onChange={(nextTags) => setDefaults({ ...defaults, tags: nextTags })} suggestions={tags} placeholder="默认标签" ariaLabel="默认标签" />
              </div>
              <button type="button" className="apply-to-all-button" disabled={busy || !queue.jobs.length} onClick={() => queue.applyDefaultsToAll(defaults)}>应用到全部</button>
            </WorkflowCollapsePanel>

            <div className="modal-scroll-list upload-list" ref={listRef}>
              {jsonlErrors.length > 0 && (
                <div className="jsonl-import-report">
                  <span>{jsonlErrors.length} 行未创建任务</span>
                  <button type="button" onClick={() => void navigator.clipboard.writeText(jsonlErrors.map((error) => `第 ${error.line} 行：${error.error}\n${error.raw}`).join("\n\n")).catch(() => undefined)}><Icon name="file-copy-line" />复制错误</button>
                  <button type="button" onClick={() => setJsonlErrors([])}>清除</button>
                </div>
              )}
              <ImportJobList jobs={queue.visibleJobs} busy={busy} storageName={storageName} themes={themes} tags={tags} authors={authors}
                onPatch={(job, patch) => queue.updateJobDraft(job.id, patch)} onCancel={(job) => void cancelJob(job)}
                onRetry={(job) => void retryJob(job)} onRemove={(job) => void removeJob(job)}
                onConfirmDuplicate={(job) => queue.updateJob(job.id, { duplicateDecision: "upload", message: "已确认提交副本" })}
                onOpenDetail={(item, opener) => {
                  detailReturnFocusRef.current = opener;
                  setDetailItem(item);
                }} onPreview={(target) => {
                  previewReturnFocusRef.current = target.opener ?? null;
                  setPreview(target);
                }} />
              {!queue.jobs.length && (mode === "link" ? (
                <button type="button" className="empty-state upload-dropzone" onClick={() => { setLinkInputMode("urls"); setUrlInputOpen(true); }}><Icon name="download-cloud-2-line" /><span>还没有导入任务，点击此处选择图片来源</span></button>
              ) : (
                <button type="button" className={`empty-state upload-dropzone${dragOver ? " is-dragover" : ""}`} onClick={() => fileInputRef.current?.click()}
                  onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
                  onDrop={(event) => { event.preventDefault(); setDragOver(false); void localImport.addFiles(event.dataTransfer.files); }}>
                  <Icon name="image-line" /><span>还没有选择图片，点击此处选择，或将图片拖到这里</span>
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
                <div className="upload-backend"><SelectMenu className="is-storage-select" value={activeBackend} onChange={setBackendChoice} options={backendOptions} ariaLabel="新任务存储位置" /></div>
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
                <button type="button" onClick={() => void clearJobs(() => true).then(() => exit.requestClose())} disabled={busy}>取消</button>
                <button className="button workflow-submit-button" type="button" disabled={!readyJobs.length || busy || duplicateJobs > 0} onClick={() => { setBusy(true); void commitImports(readyJobs).finally(() => setBusy(false)); }}>{busy ? "提交中" : readyJobs.length ? `提交 ${readyJobs.length} 张` : "提交"}</button>
              </div>
            </footer>
          </section>
          <OverlayScrollbar targetRef={listRef} />
          {detailItem && (
            <ImageDetailModal
              item={detailItem}
              admin
              onClose={() => setDetailItem(null)}
              returnFocusRef={detailReturnFocusRef}
            />
          )}
          {preview && <ImagePreviewModal src={preview.src} thumbSrc={preview.thumbSrc} width={preview.width} height={preview.height} onClose={() => setPreview(null)} returnFocusRef={previewReturnFocusRef} />}
          {urlInputOpen && (
            <LinkUrlDialog
              initialInputMode={linkInputMode}
              maxItems={linkMaxItems}
              weiboMaxItems={weiboMaxItems}
              onClose={() => setUrlInputOpen(false)}
              onSubmit={addLinks}
              returnFocusRef={linkPickerRef}
            />
          )}
        </div>
      )}
    </>
  );
}
