import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api/client.js";
import { Icon } from "../../../components/icon/Icon.js";
import { ImageDetailModal } from "../../../components/image/ImageDetailModal.js";
import { ImagePreviewModal } from "../../../components/image/ImagePreviewModal.js";
import { ThemeInput } from "../../../components/form/ThemeInput.js";
import { TagInput } from "../../../components/form/TagInput.js";
import { AuthorInput } from "../../../components/form/AuthorInput.js";
import { SelectMenu } from "../../../components/form/SelectMenu.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import { useAnimatedClose } from "../../../hooks/useAnimatedClose.js";
import { useBodyScrollLock } from "../../../hooks/useBodyScrollLock.js";
import { adminApiBasePath, queryKeys } from "../../../lib/constants.js";
import { storageBackendLabel, uploadCommonBrightnessOptions, uploadCommonDeviceOptions } from "../../../lib/ui/select-options.js";
import { useStorageOptions } from "../../../lib/api/storage-options.js";
import type { AdminSettings, FacetOption, ImageItem, ImportJob } from "../../../lib/types.js";
import type { CommonImageAttributes } from "../../../lib/upload/upload-utils.js";
import { ImportJobList } from "./ImportJobList.js";
import type { ImportPreviewTarget } from "./DuplicateMatchPanel.js";
import { LinkUrlDialog, type LinkDialogSubmission, type LinkInputMode } from "./link-import/LinkUrlDialog.js";
import { LinkImportSplitButton } from "./link-import/LinkImportSplitButton.js";
import { jsonlImportJobs } from "./link-import/jsonl-jobs.js";
import type { JsonlManifestParseError } from "./import-api.js";
import { useImportQueue } from "./useImportQueue.js";
import { useLocalUploadImport } from "./useLocalUploadImport.js";
import { useLinkImport } from "./link-import/useLinkImport.js";
import { useImportCommit } from "./useImportCommit.js";
import { useImportStatusEvents } from "./useImportStatusEvents.js";

export function Uploader({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"file" | "link">("file");
  const [urlInputOpen, setUrlInputOpen] = useState(false);
  const [linkInputMode, setLinkInputMode] = useState<LinkInputMode>("urls");
  const [jsonlErrors, setJsonlErrors] = useState<JsonlManifestParseError[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [defaults, setDefaults] = useState<CommonImageAttributes>({ device: "", brightness: "", theme: "", author: "", tags: [] });
  const [busy, setBusy] = useState(false);
  const [detailItem, setDetailItem] = useState<ImageItem | null>(null);
  const [preview, setPreview] = useState<ImportPreviewTarget | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);

  const { data: settingsData } = useQuery<{ settings: AdminSettings }>({ queryKey: queryKeys.settings, queryFn: () => api(`${adminApiBasePath}/settings`) });
  const { data: vocabulary } = useQuery<{ themes: FacetOption[]; tags: FacetOption[]; authors: FacetOption[] }>({
    queryKey: queryKeys.importVocabulary,
    queryFn: () => api(`${adminApiBasePath}/import-vocabulary`),
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY
  });
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
  const urlListMaxItems = settingsData?.settings.link_image.url_list_max_items ?? 100;
  const jsonlMaxItems = settingsData?.settings.link_image.jsonl_max_items ?? 100;
  const queue = useImportQueue(pageSize);

  const { data: storageData } = useStorageOptions();
  const storageBackends = storageData?.backends ?? [];
  const defaultBackend = storageBackends.find((backend) => backend.is_default)?.slug ?? "local";
  const [backendChoice, setBackendChoice] = useState("");
  const activeBackend = backendChoice || defaultBackend;
  const backendOptions = useMemo(
    () => (storageBackends.length ? storageBackends : [{ slug: "local", display_name: storageBackendLabel("local"), type: "local" as const, enabled: true, is_default: true }])
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
    queue.clearJobs((job) => ["done", "skipped"].includes(job.status));
    setJsonlErrors([]);
  });
  useBodyScrollLock(open);

  const cancelJob = async (job: ImportJob) => {
    if (job.kind === "local") await localImport.cancel(job);
    else await linkImport.cancel(job);
  };

  const openInMode = async (next: "file" | "link") => {
    const discarded = queue.jobsRef.current.filter((job) => next === "file" ? job.kind !== "local" : job.kind === "local");
    await Promise.all(discarded.filter((job) => !["done", "skipped", "cancelled"].includes(job.status)).map(cancelJob));
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
    if (!["done", "skipped", "cancelled"].includes(job.status)) await cancelJob(job);
    queue.removeJob(job.id);
  };

  const clearJobs = async (predicate: (job: ImportJob) => boolean) => {
    const targets = queue.jobsRef.current.filter(predicate);
    // cancelJob 会先把任务改成 cancelled。固定本次 ID，避免取消完成后再次按旧状态条件
    // 筛选，导致“重复待确认”任务找不到而仍留在总数中；期间新产生的重复项也不会误删。
    const targetIds = new Set(targets.map((job) => job.id));
    const cancellationRequests = targets
      .filter((job) => !["done", "skipped", "cancelled"].includes(job.status))
      .map(cancelJob);
    // 取消函数在首个 await 前已经中止活动请求并标记任务；服务端暂存对象清理可能较慢，
    // 不应阻塞用户明确要求的本地队列清理和总数更新。
    queue.clearJobIds(targetIds);
    await Promise.allSettled(cancellationRequests);
  };

  const openLinkInput = async (inputMode: LinkInputMode) => {
    setLinkInputMode(inputMode);
    await openInMode("link");
    setUrlInputOpen(true);
  };

  const addLinks = (submission: LinkDialogSubmission) => {
    if (submission.inputMode === "urls") {
      void linkImport.addUrls(submission.urls, submission.mode);
      return;
    }
    setJsonlErrors((current) => [...current, ...submission.manifest.errors]);
    const jobs = jsonlImportJobs(submission.manifest.items, defaults, submission.mode, activeBackend);
    void linkImport.addJobs(jobs);
  };

  const readyJobs = queue.jobs.filter((job) => job.status === "ready" && job.duplicateDecision !== "undecided");
  const duplicateJobs = queue.jobs.filter((job) => job.status === "ready" && job.duplicateDecision === "undecided").length;
  const runningJobs = queue.jobs.filter((job) => ["queued", "uploading", "downloading", "processing", "committing"].includes(job.status)).length;
  const doneJobs = queue.jobs.filter((job) => job.status === "done").length;
  const failedJobs = queue.jobs.filter((job) => job.status === "failed").length;
  const skippedJobs = queue.jobs.filter((job) => job.status === "skipped").length;
  const modeTitle = mode === "file" ? "上传图片" : "链接导入";
  const emptySubtitle = mode === "file"
    ? "选择后立即上传并在服务端准备图片"
    : "输入后立即下载并在服务端准备图片";

  return (
    <>
      <div className="upload-triggers">
        <LinkImportSplitButton onOpenUrls={() => void openLinkInput("urls")} onOpenJsonl={() => void openLinkInput("jsonl")} />
        <button className="button upload-trigger" type="button" onClick={() => void openInMode("file")}><Icon name="upload-cloud-2-line" />上传图片</button>
      </div>
      {open && (
        <div className={`upload-overlay ${exit.closing ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-label={modeTitle} onAnimationEnd={exit.onAnimationEnd}>
          <section className="upload-window">
            <header className="upload-window-header">
              <div className="upload-head-copy">
                <h1>{modeTitle}</h1>
                {queue.jobs.length ? (
                  <p className="upload-task-summary">
                    <span className="upload-summary-primary">
                      {queue.jobs.length} 个任务，{runningJobs} 个处理中，{readyJobs.length} 个待提交；
                    </span>
                    <span className="upload-summary-secondary">
                      {doneJobs} 个成功，{skippedJobs} 个跳过，{failedJobs} 个失败，{duplicateJobs} 个重复待确认
                      {jsonlErrors.length ? `，${jsonlErrors.length} 行解析失败` : ""}
                    </span>
                  </p>
                ) : (
                  <p>{emptySubtitle}</p>
                )}
              </div>
              <div className="upload-head-actions">
                <div className="upload-clear-actions">
                  <button type="button" className="clear-button" disabled={busy || !duplicateJobs} onClick={() => void clearJobs((job) => job.status === "ready" && job.duplicateDecision === "undecided")}>清空重复待确认</button>
                  <button type="button" className="clear-button" disabled={busy || !queue.jobs.some((job) => !["done", "skipped"].includes(job.status))} onClick={() => void clearJobs((job) => !["done", "skipped"].includes(job.status))}>清空未提交</button>
                  <button type="button" className="clear-button" disabled={busy || !queue.jobs.some((job) => job.status === "done")} onClick={() => void clearJobs((job) => job.status === "done")}>清空已完成</button>
                </div>
                <div className="upload-primary-actions">
                  {mode === "link" ? (
                    <button type="button" className="button secondary upload-picker pressable" disabled={busy} onClick={() => { setLinkInputMode("urls"); setUrlInputOpen(true); }}><Icon name="download-cloud-2-line" />导入链接</button>
                  ) : (
                    <label className="button secondary upload-picker pressable">
                      <Icon name="upload-cloud-2-line" /><input ref={fileInputRef} type="file" accept="image/*" multiple onChange={(event) => { void localImport.addFiles(event.target.files); event.target.value = ""; }} />选择图片
                    </label>
                  )}
                  <button className="icon close pressable upload-close-button" type="button" title="关闭" onClick={() => exit.requestClose()} disabled={busy}><Icon name="close-line" /></button>
                </div>
              </div>
            </header>

            <div className="upload-defaults">
              <SelectMenu className="upload-default-select upload-default-device" value={defaults.device} onChange={(device) => setDefaults({ ...defaults, device })} options={uploadCommonDeviceOptions} ariaLabel="默认设备" />
              <SelectMenu className="upload-default-select upload-default-brightness" value={defaults.brightness} onChange={(brightness) => setDefaults({ ...defaults, brightness })} options={uploadCommonBrightnessOptions} ariaLabel="默认亮度" />
              <div className="upload-default-pair">
                <ThemeInput className="upload-default-theme" value={defaults.theme} onChange={(theme) => setDefaults({ ...defaults, theme })} themes={themes} placeholder="主题" ariaLabel="默认主题" />
                <TagInput className="upload-default-tags" value={defaults.tags} onChange={(nextTags) => setDefaults({ ...defaults, tags: nextTags })} suggestions={tags} placeholder="默认标签" ariaLabel="默认标签" />
                <AuthorInput className="upload-default-author" value={defaults.author} onChange={(author) => setDefaults({ ...defaults, author })} authors={authors} placeholder="默认作者" ariaLabel="默认作者" />
              </div>
              <button type="button" className="apply-to-all-button" disabled={busy || !queue.jobs.length} onClick={() => queue.applyDefaultsToAll(defaults)}>应用到全部</button>
            </div>

            {jsonlErrors.length > 0 && (
              <div className="jsonl-import-report">
                <span>{jsonlErrors.length} 行未创建任务</span>
                <button type="button" onClick={() => void navigator.clipboard.writeText(jsonlErrors.map((error) => `第 ${error.line} 行：${error.error}\n${error.raw}`).join("\n\n")).catch(() => undefined)}><Icon name="file-copy-line" />复制错误</button>
                <button type="button" onClick={() => setJsonlErrors([])}>清除</button>
              </div>
            )}

            <div className="modal-scroll-list upload-list" ref={listRef}>
              <ImportJobList jobs={queue.visibleJobs} busy={busy} storageName={storageName} themes={themes} tags={tags} authors={authors}
                onPatch={(job, patch) => queue.updateJobDraft(job.id, patch)} onCancel={(job) => void cancelJob(job)}
                onRetry={(job) => void retryJob(job)} onRemove={(job) => void removeJob(job)}
                onConfirmDuplicate={(job) => queue.updateJob(job.id, { duplicateDecision: "upload", message: "已确认提交副本" })}
                onOpenDetail={(item, opener) => {
                  detailReturnFocusRef.current = opener;
                  setDetailItem(item);
                }} onPreview={setPreview} />
              {!queue.jobs.length && (mode === "link" ? (
                <button type="button" className="empty-state upload-dropzone" onClick={() => { setLinkInputMode("urls"); setUrlInputOpen(true); }}><Icon name="download-cloud-2-line" /><span>还没有导入链接，点击此处输入图片链接</span></button>
              ) : (
                <button type="button" className={`empty-state upload-dropzone${dragOver ? " is-dragover" : ""}`} onClick={() => fileInputRef.current?.click()}
                  onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
                  onDrop={(event) => { event.preventDefault(); setDragOver(false); void localImport.addFiles(event.dataTransfer.files); }}>
                  <Icon name="image-line" /><span>还没有选择图片，点击此处选择，或将图片拖到这里</span>
                </button>
              ))}
            </div>

            <footer>
              <div className="upload-footer-left">
                <div className="upload-backend"><SelectMenu className="is-storage-select" value={activeBackend} onChange={setBackendChoice} options={backendOptions} ariaLabel="新任务存储位置" /></div>
                <small className="upload-storage-hint">仅影响之后添加的新任务</small>
              </div>
              <nav className="admin-pagination" aria-label="导入任务列表分页">
                <button type="button" disabled={queue.page <= 1} onClick={() => queue.setPage((page) => page - 1)}>上一页</button><span>第 {queue.page} / {queue.totalPages} 页</span><button type="button" disabled={queue.page >= queue.totalPages} onClick={() => queue.setPage((page) => page + 1)}>下一页</button>
              </nav>
              <div className="modal-footer-actions">
                <button type="button" onClick={() => void clearJobs(() => true).then(() => exit.requestClose())} disabled={busy}>取消</button>
                <button className="button" type="button" disabled={!readyJobs.length || busy || duplicateJobs > 0} onClick={() => { setBusy(true); void commitImports(readyJobs).finally(() => setBusy(false)); }}>{busy ? "提交中" : `提交 ${readyJobs.length || ""}`}</button>
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
          {preview && <ImagePreviewModal src={preview.src} thumbSrc={preview.thumbSrc} width={preview.width} height={preview.height} onClose={() => setPreview(null)} />}
          {urlInputOpen && <LinkUrlDialog initialInputMode={linkInputMode} urlListMaxItems={urlListMaxItems} jsonlMaxItems={jsonlMaxItems} onClose={() => setUrlInputOpen(false)} onSubmit={addLinks} />}
        </div>
      )}
    </>
  );
}
