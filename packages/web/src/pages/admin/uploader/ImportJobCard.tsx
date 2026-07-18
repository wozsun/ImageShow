import { Icon } from "../../../components/icon/Icon.js";
import { ImageThumbnail } from "../../../components/image/ImageThumbnail.js";
import { ImageDraftFields } from "../../../components/form/ImageDraftFields.js";
import { importCardBrightnessSelectOptions, importCardDeviceSelectOptions } from "../../../lib/ui/select-options.js";
import { formatBytes } from "../../../lib/ui/formatters.js";
import type { FacetOption, ImageDraft, ImageItem, ImportJob } from "../../../lib/types.js";
import { DuplicateMatchPanel, type ImportPreviewTarget } from "./DuplicateMatchPanel.js";

const statusLabels: Record<ImportJob["status"], string> = {
  queued: "等待中", uploading: "上传中", downloading: "下载中", processing: "处理中",
  ready: "已就绪", committing: "提交中", done: "已完成", skipped: "已跳过", failed: "失败", cancelled: "已取消"
};

function formatPixelDimensions(width?: number, height?: number) {
  return width && height ? `${width}×${height}` : "0000×0000";
}

export function ImportJobCard({ job, busy, storageDisplayName, themes, allTags, authors, onPatch, onCancel, onRetry, onRemove, onConfirmDuplicate, onOpenDetail, onPreview }: {
  job: ImportJob;
  busy: boolean;
  storageDisplayName: string;
  themes: FacetOption[];
  allTags: FacetOption[];
  authors: FacetOption[];
  onPatch: (patch: Partial<ImageDraft>) => void;
  onCancel: () => void;
  onRetry: () => void;
  onRemove: () => void;
  onConfirmDuplicate: () => void;
  onOpenDetail: (item: ImageItem, opener: HTMLElement) => void;
  onPreview: (target: ImportPreviewTarget) => void;
}) {
  const editable = job.status === "ready" && !busy;
  const running = ["queued", "uploading", "downloading", "processing"].includes(job.status);
  const retryable = ["failed", "cancelled"].includes(job.status);
  const isProxy = job.kind === "proxy";
  const hasFinalSize = typeof job.finalSize === "number";
  const displayName = job.draft.title || job.file?.name || job.url || job.id;
  const originalSizeText = formatBytes(job.originalSize ?? job.file?.size ?? 0);
  const finalSizeText = hasFinalSize ? formatBytes(job.finalSize ?? 0) : "—";
  const originalDimensionsText = formatPixelDimensions(job.originalWidth ?? job.width, job.originalHeight ?? job.height);
  const finalDimensionsText = hasFinalSize ? formatPixelDimensions(job.width, job.height) : formatPixelDimensions();
  const dimensionsText = isProxy ? originalDimensionsText : `${originalDimensionsText} → ${finalDimensionsText}`;
  const qualityText = job.quality != null
    ? String(job.quality)
    : !isProxy && job.transcoded === false ? "跳过转码" : "";
  const showsTransferProgress = ["uploading", "downloading"].includes(job.status)
    && typeof job.transferProgress === "number";
  const transferProgress = Math.min(100, Math.max(0, Math.round(job.transferProgress ?? 0)));
  const transferProgressLabel = job.status === "downloading" ? "下载进度" : "上传进度";
  const statusDetailText = job.message || statusLabels[job.status];
  const manifestLineText = job.manifestLine ? `JSONL 第 ${job.manifestLine} 行` : "";
  const metaText = [manifestLineText, storageDisplayName, dimensionsText, statusDetailText].filter(Boolean).join(" · ");
  const sizeSummaryText = isProxy
    ? `代理链接 · ${originalDimensionsText}`
    : `${originalSizeText} → ${finalSizeText}${qualityText ? ` · ${qualityText}` : ""}`;
  const libraryDuplicate = job.status === "skipped" ? job.duplicates[0] : undefined;
  const batchDuplicate = job.status === "skipped" ? job.batchDuplicate : undefined;
  const previewSrc = libraryDuplicate?.thumb_url || (batchDuplicate ? batchDuplicate.preview : job.preview);
  const openPreview: ((opener: HTMLElement) => void) | undefined = libraryDuplicate
    ? (opener) => onOpenDetail(libraryDuplicate, opener)
    : batchDuplicate?.available
      ? (opener) => onPreview({
          src: batchDuplicate.previewFull,
          thumbSrc: batchDuplicate.preview,
          width: batchDuplicate.width,
          height: batchDuplicate.height,
          opener,
        })
      : previewSrc
        ? (opener) => onPreview({
            src: job.previewFull || previewSrc,
            thumbSrc: previewSrc,
            width: job.width,
            height: job.height,
            opener,
          })
        : undefined;
  const confirmDuplicate = job.status === "ready" && job.duplicateDecision === "undecided" && job.duplicates.length > 0;
  const skippedDuplicate = job.status === "skipped" && (job.duplicates.length > 0 || Boolean(job.batchDuplicate));

  return (
    <article className={`import-job ${job.status}`}>
      <div className="import-job-aside">
        <div className="import-job-preview">
          {previewSrc
            ? <ImageThumbnail src={previewSrc} className="import-job-thumbnail" onClick={openPreview} />
            : <div className="image-thumbnail import-job-thumbnail" aria-hidden="true" />}
        </div>
        {isProxy
          ? (
            <span className="import-job-size proxy-image-note" title="代理链接图片">
              <Icon name="external-link-line" />代理链接
            </span>
          )
          : (
            <span className="import-job-size is-vertical">
              <span>{originalSizeText}</span>
              <small>{qualityText ? `↓ ${qualityText}` : "↓"}</small>
              <span>{finalSizeText}</span>
            </span>
          )}
      </div>
      <div className="import-job-head">
        <strong>
          <b className="import-status-label">【{statusLabels[job.status]}】</b>
          {displayName}
        </strong>
        <span className="import-job-meta">
          <span className="import-job-meta-copy">{metaText}</span>
          {showsTransferProgress && (
            <output className="transfer-progress-value" aria-label={`${transferProgressLabel} ${transferProgress}%`}>
              {transferProgress}%
            </output>
          )}
        </span>
        <span className="import-job-size-summary">
          {sizeSummaryText}
        </span>
      </div>
      <div className="import-job-actions">
        {retryable && <button type="button" className="icon" title="重试" onClick={onRetry} disabled={busy}><Icon name="refresh-line" /></button>}
        {running && <button type="button" className="icon danger-button" title="取消" onClick={onCancel}><Icon name="close-line" /></button>}
        {!running && <button type="button" className="icon danger-button" title="移除" onClick={onRemove} disabled={busy}><Icon name="close-line" /></button>}
      </div>
      <ImageDraftFields
        draft={job.draft} onPatch={onPatch} themes={themes} allTags={allTags} authors={authors}
        deviceOptions={importCardDeviceSelectOptions(job.draft.device)} brightnessOptions={importCardBrightnessSelectOptions(job.draft.brightness)}
        changed={{ device: job.classificationOverride?.device, brightness: job.classificationOverride?.brightness }}
        disabled={!editable} ariaPrefix={job.url ?? job.file?.name ?? job.id}
      />
      {(confirmDuplicate || skippedDuplicate) && (
        <DuplicateMatchPanel
          libraryItems={job.duplicates}
          batchDuplicate={job.batchDuplicate}
          confirmMode={confirmDuplicate}
          onOpenDetail={onOpenDetail}
          onPreview={onPreview}
          onConfirm={onConfirmDuplicate}
          onCancel={onCancel}
        />
      )}
    </article>
  );
}
