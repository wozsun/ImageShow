import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, getCsrfToken } from "../../lib/api.js";
import { Icon } from "../../components/Icon.js";
import { ImageThumbnail } from "../../components/ImageThumbnail.js";
import { ImageDetailModal } from "../../components/ImageDetailModal.js";
import { ThemeInput } from "../../components/ThemeInput.js";
import { SelectMenu } from "../../components/SelectMenu.js";
import { OverlayScrollbar } from "../../components/OverlayScrollbar.js";
import { useAnimatedClose } from "../../components/useAnimatedClose.js";
import { useBodyScrollLock } from "../../components/useBodyScrollLock.js";
import { adminApiBasePath, queryKeys } from "../../lib/constants.js";
import { formatImageMeta } from "../../lib/formatters.js";
import { brightnessSelectOptions, deviceSelectOptions, storageBackendLabel } from "../../lib/select-options.js";
import type { AdminSettings, Brightness, Device, GalleryOptions, ImageDraft, ImageItem, StorageBackend, UploadJob } from "../../lib/types.js";
import { browserUuid, type CommonAttributes, draftFromFile, fileExt, formatBytes, isUploadableImage, md5File, normalizeTheme, putFileWithProgress, titleFromFile } from "../../lib/upload-utils.js";

export function Uploader({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const jobsRef = useRef<UploadJob[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Apply-to-all defaults. Device/brightness start blank ("" = 自动识别) so newly
  // added files keep their filename/aspect-detected values; picking a concrete
  // value (incl. "未设置") then applies it to existing and future jobs.
  const [defaults, setDefaults] = useState<CommonAttributes>({ device: "", brightness: "", theme: "" });
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  // A duplicate preview card opens the existing image in the shared detail modal.
  const [detailItem, setDetailItem] = useState<ImageItem | null>(null);
  const { data: settingsData } = useQuery<{ settings: AdminSettings }>({ queryKey: queryKeys.settings, queryFn: () => api(`${adminApiBasePath}/settings`) });
  const { data: galleryOptions } = useQuery<GalleryOptions>({ queryKey: queryKeys.galleryOptions, queryFn: () => api("/api/gallery-options") });
  const themes = galleryOptions?.themes ?? [];
  const pageSize = settingsData?.settings.upload.list_page_size ?? 20;
  const maxBytes = (settingsData?.settings.upload.max_file_size_mb ?? 15) * 1024 * 1024;
  const maxLongEdge = settingsData?.settings.upload.max_long_edge ?? 8192;
  const storageSettings = settingsData?.settings.storage;
  const defaultBackend: StorageBackend = storageSettings?.backend ?? "local";
  const s3 = storageSettings?.s3;
  // S3 is offered as a target whenever its credentials are present, even if it
  // isn't the default backend (both backends can hold images side by side).
  const s3Ready = Boolean(s3 && s3.endpoint && s3.bucket && s3.access_key_id && s3.secret_access_key_configured);
  const [backendChoice, setBackendChoice] = useState<StorageBackend | "">("");
  // Follow the default until the user explicitly picks a target for this batch.
  const activeBackend: StorageBackend = backendChoice || defaultBackend;
  const backendOptions = useMemo(() => {
    const options = [{ value: "local", label: storageBackendLabel("local") }];
    if (s3Ready) options.push({ value: "s3", label: storageBackendLabel("s3") });
    return options;
  }, [s3Ready]);
  // Closing the window drops already-uploaded jobs so a reopened window starts
  // clean; pending/failed jobs are kept so unfinished work isn't lost.
  const exit = useAnimatedClose(() => {
    setOpen(false);
    clearJobs((job) => job.status === "done");
  });
  useBodyScrollLock(open);

  useEffect(() => { jobsRef.current = jobs; }, [jobs]);
  useEffect(() => () => jobsRef.current.forEach((job) => URL.revokeObjectURL(job.preview)), []);

  const updateJob = (id: string, patch: Partial<UploadJob>) => setJobs((current) => current.map((job) => job.id === id ? { ...job, ...patch } : job));
  const updateJobDraft = (id: string, patch: Partial<ImageDraft>) => setJobs((current) => current.map((job) => job.id === id ? { ...job, draft: { ...job.draft, ...patch } } : job));
  // Applies the default bar to every not-yet-uploaded job. Device/brightness left at
  // "自动识别" ("") re-derive each job's filename/aspect-detected value (未设置 if none
  // was found); a concrete pick (incl. 未设置) overwrites. An empty theme is left as a
  // free-text "no change", so manual themes survive.
  const applyDefaultsToAll = () => setJobs((current) => current.map((job) => job.status === "done" ? job : {
    ...job,
    draft: {
      ...job.draft,
      device: defaults.device ? (defaults.device as Device) : job.detected.device,
      brightness: defaults.brightness ? (defaults.brightness as Brightness) : job.detected.brightness,
      ...(defaults.theme.trim() ? { theme: defaults.theme } : {})
    }
  }));
  const retryableJobs = jobs.filter((job) => (job.status === "queued" || job.status === "failed") && job.duplicateDecision !== "undecided" && Boolean(job.md5) && job.file.size <= maxBytes && Math.max(job.width, job.height) <= maxLongEdge);
  const undecidedDuplicates = jobs.filter((job) => job.duplicateDecision === "undecided").length;
  const totalPages = Math.max(1, Math.ceil(jobs.length / pageSize));
  const visibleJobs = useMemo(() => jobs.slice((page - 1) * pageSize, page * pageSize), [jobs, page, pageSize]);
  useEffect(() => setPage((current) => Math.min(current, totalPages)), [totalPages]);

  const addFiles = async (files: FileList | null) => {
    const candidates = Array.from(files ?? []).filter(isUploadableImage);
    const next = await Promise.all(candidates.map(async (file) => {
      const preview = URL.createObjectURL(file);
      const inferred = await draftFromFile(file, defaults, preview);
      return {
        id: browserUuid(),
        file,
        status: file.size > maxBytes || !inferred.width || !inferred.height || Math.max(inferred.width, inferred.height) > maxLongEdge ? "failed" as const : "hashing" as const,
        message: file.size > maxBytes ? "文件超过大小限制" : !inferred.width || !inferred.height ? "无法解码图片" : Math.max(inferred.width, inferred.height) > maxLongEdge ? `长边超过 ${maxLongEdge}px` : "计算 MD5",
        preview,
        draft: inferred.draft,
        width: inferred.width,
        height: inferred.height,
        md5: "",
        uploadProgress: 0,
        duplicates: [],
        duplicateDecision: "upload" as const,
        detected: inferred.detected
      };
    }));
    setJobs((current) => [...current, ...next]);
    setPage(Math.max(1, Math.ceil((jobsRef.current.length + next.length) / pageSize)));
    for (const job of next) {
      if (job.status === "failed") continue;
      try {
        const md5 = await md5File(job.file);
        // De-dup the queue by default: if an earlier job already holds these exact
        // bytes, silently drop this newcomer instead of queueing a second copy.
        if (jobsRef.current.some((other) => other.id !== job.id && other.md5 === md5)) {
          removeJob(job.id);
          continue;
        }
        const duplicate = await api<{ exists: boolean; items: ImageItem[] }>(`${adminApiBasePath}/images/check-md5`, {
          method: "POST",
          body: JSON.stringify({ md5 })
        });
        updateJob(job.id, {
          md5,
          duplicates: duplicate.items ?? [],
          duplicateDecision: duplicate.exists ? "undecided" : "upload",
          status: "queued",
          message: duplicate.exists ? `发现 ${duplicate.items.length} 张相同图片` : "等待上传"
        });
      } catch (err) {
        updateJob(job.id, { status: "failed", message: (err as Error).message });
      }
    }
  };

  function removeJob(id: string) {
    setJobs((current) => {
      const target = current.find((job) => job.id === id);
      if (target) URL.revokeObjectURL(target.preview);
      return current.filter((job) => job.id !== id);
    });
  }

  function clearJobs(predicate: (job: UploadJob) => boolean) {
    setJobs((current) => {
      current.filter(predicate).forEach((job) => URL.revokeObjectURL(job.preview));
      return current.filter((job) => !predicate(job));
    });
  }

  async function runUpload(job: UploadJob) {
    const draft = { ...job.draft, theme: normalizeTheme(job.draft.theme) };
    updateJob(job.id, { status: "uploading", message: "创建上传会话", uploadProgress: 0 });
    const created = await api<{ id: string; upload_url: string; upload_headers: Record<string, string>; upload_backend: string }>(
      `${adminApiBasePath}/uploads/create`,
      {
        method: "POST",
        body: JSON.stringify({
          ...draft,
          title: draft.title || titleFromFile(job.file),
          original_filename: job.file.name,
          client_ext: fileExt(job.file),
          size: job.file.size,
          md5: job.md5,
          width: job.width,
          height: job.height,
          idempotency_key: job.id,
          storage_backend: activeBackend
        })
      }
    );
    updateJob(job.id, { message: "上传文件", uploadProgress: 0 });
    const headers = new Headers(created.upload_headers ?? {});
    // Local uploads PUT same-origin to the app and need the admin CSRF header;
    // S3 direct uploads go cross-origin to the bucket and must not carry it.
    if (created.upload_backend !== "s3-direct") headers.set("x-csrf-token", getCsrfToken());
    await putFileWithProgress(created.upload_url, headers, job.file, (progress) => {
      updateJob(job.id, { uploadProgress: progress });
    });
    updateJob(job.id, { status: "finalizing", message: "写入图库", uploadProgress: 100 });
    await api(`${adminApiBasePath}/uploads/${created.id}/complete`, { method: "POST" });
    updateJob(job.id, { status: "done", message: "完成", uploadProgress: 100 });
  }

  async function uploadQueued() {
    setBusy(true);
    try {
      for (const job of retryableJobs) {
        try {
          await runUpload(job);
        } catch (err) {
          updateJob(job.id, { status: "failed", message: (err as Error).message });
        }
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="upload-summary">
        <div>
          <h2><Icon name="upload-cloud-2-line" />上传</h2>
          <p>选择图片后会进入上传窗口，可在提交前逐张编辑分类、标题、来源和原图链接。</p>
        </div>
        <button className="button" type="button" onClick={() => setOpen(true)}><Icon name="upload-cloud-2-line" />上传图片</button>
      </section>
      {open && (
        <div className={`upload-overlay ${exit.closing ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-label="上传图片" onAnimationEnd={exit.onAnimationEnd}>
          <section className="upload-window">
            <header>
              <div>
                <h1>上传图片</h1>
                <p>{jobs.length ? `${jobs.length} 个文件，${retryableJobs.length} 个待上传${undecidedDuplicates ? `，${undecidedDuplicates} 个重复待确认` : ""}` : "先设置默认属性，再选择图片"}</p>
              </div>
              <div className="upload-head-actions">
                <label className="button secondary upload-picker pressable"><Icon name="upload-cloud-2-line" /><input type="file" accept="image/*" multiple onChange={(event) => void addFiles(event.target.files)} />选择图片</label>
                <button className="icon close pressable" type="button" title="关闭" onClick={() => exit.requestClose()} disabled={busy}><Icon name="close-line" /></button>
              </div>
            </header>

            <div className="upload-defaults">
              <SelectMenu className="upload-default-select" value={defaults.device} onChange={(value) => setDefaults({ ...defaults, device: value })} options={[{ value: "", label: "设备自动识别" }, ...deviceSelectOptions]} ariaLabel="默认设备" />
              <SelectMenu className="upload-default-select" value={defaults.brightness} onChange={(value) => setDefaults({ ...defaults, brightness: value })} options={[{ value: "", label: "亮度自动识别" }, ...brightnessSelectOptions]} ariaLabel="默认亮度" />
              <ThemeInput className="upload-default-theme" value={defaults.theme} onChange={(theme) => setDefaults({ ...defaults, theme })} themes={themes} placeholder="主题" ariaLabel="默认主题" />
              <button type="button" className="upload-apply-defaults" disabled={busy || !jobs.length} onClick={applyDefaultsToAll} title="将设置的属性套用到所有待上传图片">应用到全部</button>
              <button type="button" className="clear-button" disabled={busy || !jobs.length} onClick={() => clearJobs((job) => job.status !== "done")}>清空未上传</button>
              <button type="button" className="clear-button" disabled={busy || !jobs.length} onClick={() => clearJobs((job) => job.status === "done")}>清空已上传</button>
            </div>

            <div className="modal-scroll-list upload-list" ref={listRef}>
              {visibleJobs.map((job) => (
                <article key={job.id} className={`upload-job ${job.status}`}>
                  <ImageThumbnail src={job.preview} className="upload-job-thumbnail" />
                  <div className="upload-job-head">
                    <strong>{job.file.name}</strong>
                    <span>{formatBytes(job.file.size)} · {job.md5 || "md5 计算中"} · <span className={job.duplicateDecision === "upload" && job.duplicates.length > 0 && job.status === "queued" ? "dup-confirmed" : undefined}>{job.message}</span></span>
                    {(job.status === "uploading" || job.status === "finalizing" || job.status === "done") && (
                      <div className="upload-progress" aria-label="上传进度"><span style={{ width: `${job.uploadProgress}%` }} /></div>
                    )}
                  </div>
                  <button type="button" className="icon danger-button" title="移除" onClick={() => removeJob(job.id)} disabled={busy}><Icon name="close-line" /></button>
                  <div className="upload-job-fields">
                    <input value={job.draft.title} onChange={(event) => updateJobDraft(job.id, { title: event.target.value })} placeholder="标题" disabled={busy || job.status === "done"} />
                    <SelectMenu value={job.draft.device} onChange={(value) => updateJobDraft(job.id, { device: value as Device })} disabled={busy || job.status === "done"} options={deviceSelectOptions} ariaLabel={`${job.file.name} 设备`} />
                    <SelectMenu value={job.draft.brightness} onChange={(value) => updateJobDraft(job.id, { brightness: value as Brightness })} disabled={busy || job.status === "done"} options={brightnessSelectOptions} ariaLabel={`${job.file.name} 亮度`} />
                    <ThemeInput value={job.draft.theme} onChange={(theme) => updateJobDraft(job.id, { theme })} themes={themes} placeholder="主题" disabled={busy || job.status === "done"} ariaLabel={`${job.file.name} 主题`} />
                    <input value={job.draft.source} onChange={(event) => updateJobDraft(job.id, { source: event.target.value })} placeholder="来源 URL" disabled={busy || job.status === "done"} />
                    <input value={job.draft.original} onChange={(event) => updateJobDraft(job.id, { original: event.target.value })} placeholder="原图 URL" disabled={busy || job.status === "done"} />
                    <textarea value={job.draft.description} onChange={(event) => updateJobDraft(job.id, { description: event.target.value })} placeholder="详情描述" disabled={busy || job.status === "done"} />
                  </div>
                  {job.duplicateDecision === "undecided" && !!job.duplicates.length && (
                    <div className="duplicate-panel">
                      <div className="duplicate-note">
                        <strong>已存在相同图片</strong>
                        <span>确认后可继续上传副本，或移除此文件。</span>
                      </div>
                      <div className="duplicate-body">
                        <div className="duplicate-list">
                          {job.duplicates.map((item) => (
                            <button type="button" key={item.id} className="duplicate-item" onClick={() => setDetailItem(item)}>
                              <ImageThumbnail src={item.thumb_url} size="small" />
                              <span>{item.title || item.id}</span>
                              <small>{formatImageMeta(item)}</small>
                            </button>
                          ))}
                        </div>
                        <div className="inline-actions">
                          <button type="button" onClick={() => updateJob(job.id, { duplicateDecision: "upload", message: "副本文件等待上传" })}>仍然上传</button>
                          <button className="danger-button" type="button" onClick={() => removeJob(job.id)}>移除</button>
                        </div>
                      </div>
                    </div>
                  )}
                </article>
              ))}
              {!jobs.length && <p className="empty-state">还没有选择图片</p>}
            </div>

            <footer>
              <div className="upload-footer-left">
                <div className="upload-backend">
                  <SelectMenu className="is-storage-select" value={activeBackend} onChange={(value) => setBackendChoice(value as StorageBackend)} options={backendOptions} ariaLabel="本次上传的存储位置" disabled={busy} />
                </div>
                <button type="button" className="clear-button" disabled={busy || !undecidedDuplicates} onClick={() => clearJobs((job) => job.duplicateDecision === "undecided")} title="清空与图库已有图片重复、尚未确认的图片">清空重复待确认</button>
              </div>
              <nav className="admin-pagination" aria-label="上传列表分页">
                <button type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>上一页</button>
                <span>第 {page} / {totalPages} 页</span>
                <button type="button" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>下一页</button>
              </nav>
              <div className="modal-footer-actions">
                <button type="button" className="clear-button" disabled={busy || !jobs.length} onClick={() => clearJobs(() => true)}>清空列表</button>
                <button type="button" onClick={() => exit.requestClose()} disabled={busy}>关闭</button>
                <button className="button" type="button" disabled={!retryableJobs.length || busy || undecidedDuplicates > 0} onClick={uploadQueued}>{busy ? "上传中" : "开始上传"}</button>
              </div>
            </footer>
          </section>
          <OverlayScrollbar targetRef={listRef} />
          {detailItem && <ImageDetailModal item={detailItem} admin onClose={() => setDetailItem(null)} />}
        </div>
      )}
    </>
  );
}
