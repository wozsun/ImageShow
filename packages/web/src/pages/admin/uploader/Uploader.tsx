import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api/client.js";
import { Icon } from "../../../components/icon/Icon.js";
import { ImageDetailModal } from "../../../components/image/ImageDetailModal.js";
import { ImagePreview } from "../../../components/image/ImagePreview.js";
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
import type { AdminSettings, Author, ImageItem, ImportJob, Tag, Theme } from "../../../lib/types.js";
import type { CommonAttributes } from "../../../lib/upload/upload-utils.js";
import { ImportJobList } from "./ImportJobList.js";
import { LinkUrlDialog, type LinkImportMode } from "./link-import/LinkUrlDialog.js";
import { useImportQueue } from "./useImportQueue.js";
import { useLocalUploadImport } from "./useLocalUploadImport.js";
import { useDownloadImport } from "./link-import/useDownloadImport.js";
import { useProxyLinkImport } from "./link-import/useProxyLinkImport.js";
import { useImportCommit } from "./useImportCommit.js";
import { useImportStatusEvents } from "./useImportStatusEvents.js";

export function Uploader({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"file" | "link">("file");
  const [urlInputOpen, setUrlInputOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [defaults, setDefaults] = useState<CommonAttributes>({ device: "", brightness: "", theme: "", author: "", tags: [] });
  const [busy, setBusy] = useState(false);
  const [detailItem, setDetailItem] = useState<ImageItem | null>(null);
  const [preview, setPreview] = useState<{ src: string; thumbSrc: string; width?: number; height?: number } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { data: settingsData } = useQuery<{ settings: AdminSettings }>({ queryKey: queryKeys.settings, queryFn: () => api(`${adminApiBasePath}/settings`) });
  const { data: themeData } = useQuery<{ items: Theme[] }>({ queryKey: queryKeys.themes, queryFn: () => api(`${adminApiBasePath}/themes`), enabled: open });
  const { data: tagData } = useQuery<{ items: Tag[] }>({ queryKey: queryKeys.tags, queryFn: () => api(`${adminApiBasePath}/tags`), enabled: open });
  const { data: authorData } = useQuery<{ items: Author[] }>({ queryKey: queryKeys.authors, queryFn: () => api(`${adminApiBasePath}/authors`), enabled: open });
  const themes = themeData?.items ?? [];
  const tags = tagData?.items ?? [];
  const authors = authorData?.items ?? [];

  const pageSize = settingsData?.settings.upload.list_page_size ?? 20;
  const maxBytes = (settingsData?.settings.upload.max_file_size_mb ?? 15) * 1024 * 1024;
  const uploadConcurrency = settingsData?.settings.upload.concurrency ?? 2;
  const downloadConcurrency = settingsData?.settings.link_image.concurrency ?? 2;
  const fillOriginalUrl = settingsData?.settings.link_image.fill_original_url ?? false;
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
    claimPreparedMd5: queue.claimPreparedMd5
  };
  const localImport = useLocalUploadImport({ queue: queueApi, defaults, storageSlug: activeBackend, maxBytes, concurrency: uploadConcurrency });
  const downloadImport = useDownloadImport({ queue: queueApi, defaults, fillOriginalUrl, storageSlug: activeBackend, concurrency: downloadConcurrency });
  const proxyImport = useProxyLinkImport({ queue: queueApi, defaults, fillOriginalUrl, storageSlug: activeBackend, concurrency: uploadConcurrency });
  const commitImports = useImportCommit({ updateJob: queue.updateJob, concurrency: Math.max(uploadConcurrency, downloadConcurrency), onDone });
  useImportStatusEvents(queue.jobs, queue.jobsRef, queue.updateJob);

  const exit = useAnimatedClose(() => {
    setOpen(false);
    queue.clearJobs((job) => job.status === "done");
  });
  useBodyScrollLock(open);

  const cancelJob = async (job: ImportJob) => {
    if (job.kind === "local") await localImport.cancel(job);
    else if (job.kind === "download") await downloadImport.cancel(job);
    else await proxyImport.cancel(job);
  };

  const openInMode = async (next: "file" | "link") => {
    const discarded = queue.jobsRef.current.filter((job) => next === "file" ? job.kind !== "local" : job.kind === "local");
    await Promise.all(discarded.filter((job) => !["done", "cancelled"].includes(job.status)).map(cancelJob));
    queue.retainMode(next);
    setMode(next);
    setOpen(true);
  };

  const retryJob = async (job: ImportJob) => {
    if (job.failureStage === "commit") {
      setBusy(true);
      await commitImports([job]).finally(() => setBusy(false));
      return;
    }
    if (job.kind === "local") await localImport.retry(job);
    else if (job.kind === "download") await downloadImport.retry(job);
    else await proxyImport.retry(job);
  };

  const removeJob = async (job: ImportJob) => {
    if (!["done", "cancelled"].includes(job.status)) await cancelJob(job);
    queue.removeJob(job.id);
  };

  const clearJobs = async (predicate: (job: ImportJob) => boolean) => {
    const targets = queue.jobsRef.current.filter(predicate);
    await Promise.all(targets.filter((job) => !["done", "cancelled"].includes(job.status)).map(cancelJob));
    queue.clearJobs(predicate);
  };

  const addLinks = (urls: string[], linkMode: LinkImportMode) => {
    if (linkMode === "download") void downloadImport.addUrls(urls);
    else void proxyImport.addUrls(urls);
  };

  const readyJobs = queue.jobs.filter((job) => job.status === "ready" && job.duplicateDecision !== "undecided");
  const duplicateJobs = queue.jobs.filter((job) => job.status === "ready" && job.duplicateDecision === "undecided").length;
  const runningJobs = queue.jobs.filter((job) => ["queued", "uploading", "downloading", "processing", "committing"].includes(job.status)).length;
  const modeTitle = mode === "file" ? "上传图片" : "链接导入";
  const subtitle = queue.jobs.length
    ? `${queue.jobs.length} 个任务，${runningJobs} 个处理中，${readyJobs.length} 个待提交${duplicateJobs ? `，${duplicateJobs} 个重复待确认` : ""}`
    : mode === "file" ? "选择后立即上传并在服务端准备图片" : "输入后立即下载并在服务端准备图片";

  return (
    <>
      <div className="upload-triggers">
        <button className="button secondary upload-trigger" type="button" onClick={() => void openInMode("link")}><Icon name="download-cloud-2-line" />链接导入</button>
        <button className="button upload-trigger" type="button" onClick={() => void openInMode("file")}><Icon name="upload-cloud-2-line" />上传图片</button>
      </div>
      {open && (
        <div className={`upload-overlay ${exit.closing ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-label={modeTitle} onAnimationEnd={exit.onAnimationEnd}>
          <section className="upload-window">
            <header>
              <div><h1>{modeTitle}</h1><p>{subtitle}</p></div>
              <div className="upload-head-actions">
                <button type="button" className="clear-button" disabled={busy || !duplicateJobs} onClick={() => void clearJobs((job) => job.status === "ready" && job.duplicateDecision === "undecided")}>清空重复待确认</button>
                <button type="button" className="clear-button" disabled={busy || !queue.jobs.some((job) => job.status !== "done")} onClick={() => void clearJobs((job) => job.status !== "done")}>清空未提交</button>
                <button type="button" className="clear-button" disabled={busy || !queue.jobs.some((job) => job.status === "done")} onClick={() => void clearJobs((job) => job.status === "done")}>清空已提交</button>
                {mode === "link" ? (
                  <button type="button" className="button secondary upload-picker pressable" disabled={busy} onClick={() => setUrlInputOpen(true)}><Icon name="download-cloud-2-line" />导入链接</button>
                ) : (
                  <label className="button secondary upload-picker pressable">
                    <Icon name="upload-cloud-2-line" /><input ref={fileInputRef} type="file" accept="image/*" multiple onChange={(event) => { void localImport.addFiles(event.target.files); event.target.value = ""; }} />选择图片
                  </label>
                )}
                <button className="icon close pressable" type="button" title="关闭" onClick={() => exit.requestClose()} disabled={busy}><Icon name="close-line" /></button>
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

            <div className="modal-scroll-list upload-list" ref={listRef}>
              <ImportJobList jobs={queue.visibleJobs} busy={busy} storageName={storageName} themes={themes} tags={tags} authors={authors}
                onPatch={(job, patch) => queue.updateJobDraft(job.id, patch)} onCancel={(job) => void cancelJob(job)}
                onRetry={(job) => void retryJob(job)} onRemove={(job) => void removeJob(job)}
                onConfirmDuplicate={(job) => queue.updateJob(job.id, { duplicateDecision: "upload", message: "已确认提交副本" })}
                onOpenDetail={setDetailItem} onPreview={(job) => setPreview({ src: job.previewFull || job.preview, thumbSrc: job.preview, width: job.width, height: job.height })} />
              {!queue.jobs.length && (mode === "link" ? (
                <button type="button" className="empty-state upload-dropzone" onClick={() => setUrlInputOpen(true)}><Icon name="download-cloud-2-line" /><span>还没有导入链接，点击此处输入图片链接</span></button>
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
          {detailItem && <ImageDetailModal item={detailItem} admin onClose={() => setDetailItem(null)} />}
          {preview && <ImagePreview src={preview.src} thumbSrc={preview.thumbSrc} width={preview.width} height={preview.height} onClose={() => setPreview(null)} />}
          {urlInputOpen && <LinkUrlDialog onClose={() => setUrlInputOpen(false)} onSubmit={addLinks} />}
        </div>
      )}
    </>
  );
}
