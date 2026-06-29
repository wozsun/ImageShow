import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, getCsrfToken } from "../../lib/api.js";
import { Icon } from "../../components/Icon.js";
import { ImageDetailModal } from "../../components/ImageDetailModal.js";
import { ImagePreview } from "../../components/ImagePreview.js";
import { ThemeInput } from "../../components/ThemeInput.js";
import { TagInput } from "../../components/TagInput.js";
import { AuthorInput } from "../../components/AuthorInput.js";
import { SelectMenu } from "../../components/SelectMenu.js";
import { OverlayScrollbar } from "../../components/OverlayScrollbar.js";
import { useAnimatedClose } from "../../components/useAnimatedClose.js";
import { useBodyScrollLock } from "../../components/useBodyScrollLock.js";
import { UploadJobCard } from "./UploadJobCard.js";
import { LinkUrlDialog } from "./LinkUrlDialog.js";
import { adminApiBasePath, queryKeys } from "../../lib/constants.js";
import { storageBackendLabel, uploadCommonBrightnessOptions, uploadCommonDeviceOptions } from "../../lib/select-options.js";
import type { AdminSettings, Author, Brightness, Device, ImageDraft, ImageItem, StorageBackendOption, Tag, Theme, UploadJob } from "../../lib/types.js";
import { browserUuid, type CommonAttributes, draftFromFile, isUploadableImage, md5File, normalizeAuthor, normalizeTheme, putFileWithProgress, runWithConcurrency } from "../../lib/upload-utils.js";

// Shape returned by the link-import prepare endpoint (download + stage a thumbnail).
type LinkPrepareResult = { staging_id: string; url: string; width: number; height: number; device: Device; brightness: Brightness; ext: string; md5: string; thumb_data_url: string };

const blankDraft: ImageDraft = { title: "", description: "", source: "", original: "", device: "pc", brightness: "auto", theme: "", author: "", tags: [] };

export function Uploader({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  // The window serves two flows: "file" (pick + upload files) and "link" (import external
  // image URLs). They share the same window chrome, cards and footer; only the input source
  // and the submit step differ.
  const [mode, setMode] = useState<"file" | "link">("file");
  const [urlInputOpen, setUrlInputOpen] = useState(false);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const jobsRef = useRef<UploadJob[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // True while files are dragged over the empty-state dropzone, for hover styling.
  const [dragOver, setDragOver] = useState(false);
  // Apply-to-all defaults. Device starts blank ("" = 保持) so newly added files keep their
  // filename/aspect-detected orientation; brightness defaults to 自动亮暗 ("auto" =
  // re-detected on the server) so every image gets a brightness without manual input.
  const [defaults, setDefaults] = useState<CommonAttributes>({ device: "", brightness: "auto", theme: "", author: "", tags: [] });
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  // A duplicate preview card opens the existing image in the shared detail modal.
  const [detailItem, setDetailItem] = useState<ImageItem | null>(null);
  // Click-to-preview the card's own image (the local file for uploads, the external
  // original for links). Separate from detailItem, which opens a matched library duplicate.
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const { data: settingsData } = useQuery<{ settings: AdminSettings }>({ queryKey: queryKeys.settings, queryFn: () => api(`${adminApiBasePath}/settings`) });
  const { data: themeData } = useQuery<{ items: Theme[] }>({ queryKey: queryKeys.themes, queryFn: () => api(`${adminApiBasePath}/themes`) });
  const themes = themeData?.items ?? [];
  const { data: tagData } = useQuery<{ items: Tag[] }>({ queryKey: queryKeys.tags, queryFn: () => api(`${adminApiBasePath}/tags`) });
  const allTags = tagData?.items ?? [];
  const { data: authorData } = useQuery<{ items: Author[] }>({ queryKey: queryKeys.authors, queryFn: () => api(`${adminApiBasePath}/authors`) });
  const authors = authorData?.items ?? [];
  const pageSize = settingsData?.settings.upload.list_page_size ?? 20;
  const maxBytes = (settingsData?.settings.upload.max_file_size_mb ?? 15) * 1024 * 1024;
  const maxLongEdge = settingsData?.settings.upload.max_long_edge ?? 8192;
  // How many files upload at once (same knob the server uses for thumb.generate concurrency).
  const uploadConcurrency = settingsData?.settings.upload.concurrency ?? 2;
  // Whether a link import pre-fills its 原图URL (original) with the imported link itself.
  // File-only config, default off — when off the 原图URL starts blank for manual entry.
  const fillOriginalUrl = settingsData?.settings.link_image?.fill_original_url ?? false;
  const { data: storageData } = useQuery<{ backends: StorageBackendOption[] }>({ queryKey: ["storage-options"], queryFn: () => api(`${adminApiBasePath}/storage/options`) });
  const storageBackends = storageData?.backends ?? [];
  const defaultBackend = storageBackends.find((backend) => backend.is_default)?.slug ?? "local";
  const [backendChoice, setBackendChoice] = useState<string>("");
  // Follow the default until the user explicitly picks a target for this batch. In link mode
  // this is the thumbnail's backend (the original is only linked).
  const activeBackend = backendChoice || defaultBackend;
  const backendOptions = useMemo(
    () => (storageBackends.length ? storageBackends : [{ slug: "local", display_name: storageBackendLabel("local"), type: "local" as const, enabled: true, is_default: true }])
      // enabled gates the write-selector: a disabled backend can't be a new-upload target.
      .filter((backend) => backend.enabled)
      .map((backend) => ({ value: backend.slug, label: backend.display_name || storageBackendLabel(backend.slug) })),
    [storageData]
  );
  // Closing the window drops already-uploaded jobs so a reopened window starts
  // clean; pending/failed jobs are kept so unfinished work isn't lost.
  const exit = useAnimatedClose(() => {
    setOpen(false);
    clearJobs((job) => job.status === "done");
  });
  useBodyScrollLock(open);

  useEffect(() => { jobsRef.current = jobs; }, [jobs]);
  useEffect(() => () => jobsRef.current.forEach((job) => URL.revokeObjectURL(job.preview)), []);

  // Opens the window in one flow, dropping the other flow's jobs so a reopened window never
  // mixes picked files with imported links.
  const openInMode = (next: "file" | "link") => {
    setJobs((current) => {
      current.filter((job) => job.kind !== next).forEach((job) => URL.revokeObjectURL(job.preview));
      return current.filter((job) => job.kind === next);
    });
    setMode(next);
    setPage(1);
    setOpen(true);
  };

  const updateJob = (id: string, patch: Partial<UploadJob>) => setJobs((current) => current.map((job) => job.id === id ? { ...job, ...patch } : job));
  const updateJobDraft = (id: string, patch: Partial<ImageDraft>) => setJobs((current) => current.map((job) => job.id === id ? { ...job, draft: { ...job.draft, ...patch } } : job));
  // Applies the default bar to every not-yet-finished job. Device 自动设备 / brightness
  // 暂不设置 (both "") re-derive each job's own detected value; a concrete pick overwrites
  // (brightness 自动亮暗 = auto, re-detected on the server). An empty theme is left as a
  // free-text "no change", so manual themes survive. Non-empty default tags replace (not
  // merge into) each job's tags; an empty default-tags box leaves them alone.
  const applyDefaultsToAll = () => setJobs((current) => current.map((job) => job.status === "done" ? job : {
    ...job,
    draft: {
      ...job.draft,
      device: defaults.device ? (defaults.device as Device) : job.detected.device,
      brightness: defaults.brightness ? (defaults.brightness as Brightness) : job.detected.brightness,
      ...(defaults.theme.trim() ? { theme: defaults.theme } : {}),
      ...(defaults.author.trim() ? { author: defaults.author } : {}),
      ...(defaults.tags.length ? { tags: [...defaults.tags] } : {})
    }
  }));
  const retryableJobs = jobs.filter((job) => job.kind === "file" && (job.status === "queued" || job.status === "failed") && job.duplicateDecision !== "undecided" && Boolean(job.md5) && !!job.file && job.file.size <= maxBytes && Math.max(job.width, job.height) <= maxLongEdge);
  const undecidedDuplicates = jobs.filter((job) => job.duplicateDecision === "undecided").length;
  // Link jobs ready to commit (downloaded + staged) and those still downloading.
  const linkReady = jobs.filter((job) => job.kind === "link" && job.status === "queued" && Boolean(job.stagingId) && job.duplicateDecision !== "undecided");
  const linkPreparing = jobs.filter((job) => job.kind === "link" && job.status === "hashing").length;
  const submittable = mode === "link" ? linkReady.length : retryableJobs.length;
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
        kind: "file" as const,
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
      if (job.status === "failed" || !job.file) continue;
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

  // Adds external image links: each spawns a card that downloads server-side (prepare),
  // then fills in the thumbnail preview, dimensions and detected device/brightness — with
  // the 原图URL pre-filled to the link — ready for per-card editing before 提交 (commit).
  const addLinks = async (urls: string[]) => {
    const fresh = urls.map((url) => url.trim()).filter((url) => /^https?:\/\//i.test(url));
    const next: UploadJob[] = fresh.map((url) => ({
      id: browserUuid(),
      kind: "link" as const,
      status: "hashing" as const,
      message: "下载中…",
      preview: "",
      draft: { ...blankDraft, original: fillOriginalUrl ? url : "" },
      width: 0,
      height: 0,
      uploadProgress: 0,
      duplicates: [],
      duplicateDecision: "upload" as const,
      detected: { device: "pc", brightness: "auto" },
      url
    }));
    setJobs((current) => [...current, ...next]);
    setPage(Math.max(1, Math.ceil((jobsRef.current.length + next.length) / pageSize)));
    // Prepare (server downloads + thumbnails + auto-detects) up to `uploadConcurrency`
    // links at once — same knob as file uploads' thumbnail concurrency.
    await runWithConcurrency(next, uploadConcurrency, async (job) => {
      try {
        const res = await api<LinkPrepareResult>(`${adminApiBasePath}/import-links/prepare`, { method: "POST", body: JSON.stringify({ url: job.url }) });
        // Same library duplicate check as file uploads, so 已存在相同图片 surfaces a dup panel
        // and 清空重复待确认 applies here too. (Re-importing the exact same URL is also caught
        // at commit via ON CONFLICT(object_key).)
        const dup = await api<{ exists: boolean; items: ImageItem[] }>(`${adminApiBasePath}/images/check-md5`, { method: "POST", body: JSON.stringify({ md5: res.md5 }) });
        updateJob(job.id, {
          status: "queued",
          message: dup.exists ? `发现 ${dup.items.length} 张相同图片` : "已就绪，待提交",
          preview: res.thumb_data_url,
          width: res.width,
          height: res.height,
          stagingId: res.staging_id,
          detected: { device: res.device, brightness: res.brightness },
          duplicates: dup.items ?? [],
          duplicateDecision: dup.exists ? "undecided" : "upload",
          draft: {
            ...blankDraft,
            original: fillOriginalUrl ? res.url : "",
            // Mirror file uploads' defaults: blank device/brightness keep the detected value;
            // a concrete default overrides.
            device: defaults.device ? (defaults.device as Device) : res.device,
            brightness: defaults.brightness ? (defaults.brightness as Brightness) : res.brightness,
            theme: defaults.theme.trim() ? defaults.theme : "",
            author: defaults.author.trim() ? defaults.author : "",
            tags: defaults.tags.length ? [...defaults.tags] : []
          }
        });
      } catch (err) {
        updateJob(job.id, { status: "failed", message: (err as Error).message });
      }
    });
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
    const file = job.file;
    if (!file) return;
    const draft = { ...job.draft, theme: normalizeTheme(job.draft.theme), author: normalizeAuthor(job.draft.author) };
    updateJob(job.id, { status: "uploading", message: "创建上传会话", uploadProgress: 0 });
    const created = await api<{ id: string; upload_url: string }>(
      `${adminApiBasePath}/uploads/create`,
      {
        method: "POST",
        body: JSON.stringify({
          ...draft,
          size: file.size,
          md5: job.md5,
          idempotency_key: job.id,
          storage_slug: activeBackend
        })
      }
    );
    updateJob(job.id, { message: "上传文件", uploadProgress: 0 });
    // Every upload PUTs the bytes same-origin to the app (which streams them on to
    // the backend), so it always carries the admin CSRF header.
    const headers = new Headers({ "x-csrf-token": getCsrfToken() });
    await putFileWithProgress(created.upload_url, headers, file, (progress) => {
      updateJob(job.id, { uploadProgress: progress });
    });
    updateJob(job.id, { status: "finalizing", message: "识别明暗、生成缩略图并写入图库", uploadProgress: 100 });
    await api(`${adminApiBasePath}/uploads/${created.id}/complete`, { method: "POST" });
    updateJob(job.id, { status: "done", message: "完成", uploadProgress: 100 });
  }

  async function uploadQueued() {
    setBusy(true);
    try {
      // Upload up to `uploadConcurrency` files at once; each runUpload also finalizes
      // (read-back / brightness / thumbnail / DB write).
      await runWithConcurrency([...retryableJobs], uploadConcurrency, async (job) => {
        try {
          await runUpload(job);
        } catch (err) {
          updateJob(job.id, { status: "failed", message: (err as Error).message });
        }
      });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  // Commits each ready link: writes its staged thumbnail to the chosen backend and inserts
  // the is_link row (object_key = the URL) with the card-edited metadata.
  async function submitLinks() {
    setBusy(true);
    try {
      // Commit up to `uploadConcurrency` links at once (writes the staged thumbnail to the
      // backend + inserts the row; per-category index assignment still serializes in the DB).
      const ready = jobs.filter((item) => item.kind === "link" && item.status === "queued" && Boolean(item.stagingId));
      await runWithConcurrency(ready, uploadConcurrency, async (job) => {
        try {
          updateJob(job.id, { status: "finalizing", message: "提交中…" });
          const res = await api<{ status: "imported" | "duplicate" }>(`${adminApiBasePath}/import-links/commit`, {
            method: "POST",
            body: JSON.stringify({
              staging_id: job.stagingId,
              device: job.draft.device,
              brightness: job.draft.brightness,
              theme: normalizeTheme(job.draft.theme),
              author: normalizeAuthor(job.draft.author),
              title: job.draft.title,
              description: job.draft.description,
              source: job.draft.source,
              original: job.draft.original,
              tags: job.draft.tags,
              storage_slug: activeBackend
            })
          });
          updateJob(job.id, { status: "done", message: res.status === "duplicate" ? "链接已存在（跳过）" : "完成" });
        } catch (err) {
          updateJob(job.id, { status: "failed", message: (err as Error).message });
        }
      });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  // Everything that differs between the two flows, gathered in one place: both modes share
  // all state, the cards and the chrome, and diverge only in wording + which submit runs.
  // Adding a mode = a new entry here plus its add/submit logic (the picker element and empty
  // state stay inline below, as they close over refs/drag handlers).
  const modeConfig = mode === "link"
    ? {
        title: "链接导入",
        subtitle: jobs.length
          ? `${jobs.length} 个链接，${linkReady.length} 个待提交${linkPreparing ? `，${linkPreparing} 个下载中` : ""}${undecidedDuplicates ? `，${undecidedDuplicates} 个重复待确认` : ""}`
          : "先设置默认属性，再导入链接",
        clearActive: "清空未提交",
        clearDone: "清空已提交",
        storageAria: "缩略图存储位置",
        paginationAria: "链接列表分页",
        submitLabel: busy ? "提交中" : "提交",
        onSubmit: submitLinks
      }
    : {
        title: "上传图片",
        subtitle: jobs.length
          ? `${jobs.length} 个文件，${retryableJobs.length} 个待上传${undecidedDuplicates ? `，${undecidedDuplicates} 个重复待确认` : ""}`
          : "先设置默认属性，再选择图片",
        clearActive: "清空未上传",
        clearDone: "清空已上传",
        storageAria: "本次上传的存储位置",
        paginationAria: "上传列表分页",
        submitLabel: busy ? "上传中" : "开始上传",
        onSubmit: uploadQueued
      };

  return (
    <>
      <div className="upload-triggers">
        <button className="button secondary upload-trigger" type="button" onClick={() => openInMode("link")}>
          <Icon name="download-cloud-2-line" />链接导入
        </button>
        <button className="button upload-trigger" type="button" onClick={() => openInMode("file")}>
          <Icon name="upload-cloud-2-line" />上传图片
        </button>
      </div>
      {open && (
        <div
          className={`upload-overlay ${exit.closing ? "is-closing" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={modeConfig.title}
          onAnimationEnd={exit.onAnimationEnd}
        >
          <section className="upload-window">
            <header>
              <div>
                <h1>{modeConfig.title}</h1>
                <p>{modeConfig.subtitle}</p>
              </div>
              <div className="upload-head-actions">
                <button
                  type="button"
                  className="clear-button"
                  disabled={busy || !undecidedDuplicates}
                  onClick={() => clearJobs((job) => job.duplicateDecision === "undecided")}
                  title="清空与图库已有图片重复、尚未确认的图片"
                >
                  清空重复待确认
                </button>
                <button
                  type="button"
                  className="clear-button"
                  disabled={busy || !jobs.length}
                  onClick={() => clearJobs((job) => job.status !== "done")}
                >
                  {modeConfig.clearActive}
                </button>
                <button
                  type="button"
                  className="clear-button"
                  disabled={busy || !jobs.length}
                  onClick={() => clearJobs((job) => job.status === "done")}
                >
                  {modeConfig.clearDone}
                </button>
                {mode === "link" ? (
                  <button
                    type="button"
                    className="button secondary upload-picker pressable"
                    disabled={busy}
                    onClick={() => setUrlInputOpen(true)}
                  >
                    <Icon name="download-cloud-2-line" />导入链接
                  </button>
                ) : (
                  <label className="button secondary upload-picker pressable">
                    <Icon name="upload-cloud-2-line" />
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(event) => void addFiles(event.target.files)}
                    />
                    选择图片
                  </label>
                )}
                <button
                  className="icon close pressable"
                  type="button"
                  title="关闭"
                  onClick={() => exit.requestClose()}
                  disabled={busy}
                >
                  <Icon name="close-line" />
                </button>
              </div>
            </header>

            <div className="upload-defaults">
              <SelectMenu
                className="upload-default-select upload-default-device"
                value={defaults.device}
                onChange={(value) => setDefaults({ ...defaults, device: value })}
                options={uploadCommonDeviceOptions}
                ariaLabel="默认设备"
              />
              <SelectMenu
                className="upload-default-select upload-default-brightness"
                value={defaults.brightness}
                onChange={(value) => setDefaults({ ...defaults, brightness: value })}
                options={uploadCommonBrightnessOptions}
                ariaLabel="默认亮度"
              />
              <div className="upload-default-pair">
                <ThemeInput
                  className="upload-default-theme"
                  value={defaults.theme}
                  onChange={(theme) => setDefaults({ ...defaults, theme })}
                  themes={themes}
                  placeholder="主题"
                  ariaLabel="默认主题"
                />
                <TagInput
                  className="upload-default-tags"
                  value={defaults.tags}
                  onChange={(tags) => setDefaults({ ...defaults, tags })}
                  suggestions={allTags}
                  placeholder="默认标签"
                  ariaLabel="默认标签"
                />
                <AuthorInput
                  className="upload-default-author"
                  value={defaults.author}
                  onChange={(author) => setDefaults({ ...defaults, author })}
                  authors={authors}
                  placeholder="默认作者"
                  ariaLabel="默认作者"
                />
              </div>
              <button
                type="button"
                className="apply-to-all-button"
                disabled={busy || !jobs.length}
                onClick={applyDefaultsToAll}
                title="将设置的属性套用到所有待处理图片（标签为覆盖）"
              >
                应用到全部
              </button>
            </div>

            <div className="modal-scroll-list upload-list" ref={listRef}>
              {visibleJobs.map((job) => (
                <UploadJobCard
                  key={job.id}
                  job={job}
                  busy={busy}
                  themes={themes}
                  allTags={allTags}
                  authors={authors}
                  onPatch={(patch) => updateJobDraft(job.id, patch)}
                  onRemove={() => removeJob(job.id)}
                  onConfirmDuplicate={() => updateJob(job.id, { duplicateDecision: "upload", message: job.kind === "link" ? "已就绪，待提交" : "副本文件等待上传" })}
                  onOpenDetail={setDetailItem}
                  onPreview={() => setPreviewSrc(job.kind === "link" ? (job.url ?? job.preview) : job.preview)}
                />
              ))}
              {!jobs.length && (mode === "link" ? (
                <button type="button" className="empty-state upload-dropzone" onClick={() => setUrlInputOpen(true)}>
                  <Icon name="download-cloud-2-line" />
                  <span>还没有导入链接，点击此处输入图片链接</span>
                </button>
              ) : (
                <button
                  type="button"
                  className={`empty-state upload-dropzone${dragOver ? " is-dragover" : ""}`}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(event) => { event.preventDefault(); if (!dragOver) setDragOver(true); }}
                  onDragLeave={(event) => { if (event.currentTarget === event.target) setDragOver(false); }}
                  onDrop={(event) => { event.preventDefault(); setDragOver(false); void addFiles(event.dataTransfer.files); }}
                >
                  <Icon name="image-line" />
                  <span>还没有选择图片，点击此处选择，或将图片拖到这里</span>
                </button>
              ))}
            </div>

            <footer>
              <div className="upload-footer-left">
                <div className="upload-backend">
                  <SelectMenu
                    className="is-storage-select"
                    value={activeBackend}
                    onChange={(value) => setBackendChoice(value)}
                    options={backendOptions}
                    ariaLabel={modeConfig.storageAria}
                    disabled={busy}
                  />
                </div>
              </div>
              <nav className="admin-pagination" aria-label={modeConfig.paginationAria}>
                <button type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>上一页</button>
                <span>第 {page} / {totalPages} 页</span>
                <button type="button" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>下一页</button>
              </nav>
              <div className="modal-footer-actions">
                <button type="button" onClick={() => { clearJobs(() => true); exit.requestClose(); }} disabled={busy}>取消</button>
                <button
                  className="button"
                  type="button"
                  disabled={!submittable || busy || undecidedDuplicates > 0}
                  onClick={modeConfig.onSubmit}
                >
                  {modeConfig.submitLabel}
                </button>
              </div>
            </footer>
          </section>
          <OverlayScrollbar targetRef={listRef} />
          {detailItem && <ImageDetailModal item={detailItem} admin onClose={() => setDetailItem(null)} />}
          {previewSrc && <ImagePreview src={previewSrc} onClose={() => setPreviewSrc(null)} />}
          {urlInputOpen && (
            <LinkUrlDialog onClose={() => setUrlInputOpen(false)} onSubmit={(urls) => { setUrlInputOpen(false); void addLinks(urls); }} />
          )}
        </div>
      )}
    </>
  );
}
