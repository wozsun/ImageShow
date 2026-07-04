import { Icon } from "../../../components/icon/Icon.js";
import { ImageThumbnail } from "../../../components/image/ImageThumbnail.js";
import { ImageDraftFields } from "../../../components/form/ImageDraftFields.js";
import { importCardBrightnessSelectOptions, importCardDeviceSelectOptions } from "../../../lib/ui/select-options.js";
import { formatBytes, formatImageMeta, imageDisplayTitle } from "../../../lib/ui/formatters.js";
import type { Author, ImageDraft, ImageItem, ImportJob, Tag, Theme } from "../../../lib/types.js";

const statusLabels: Record<ImportJob["status"], string> = {
  queued: "等待中", uploading: "上传中", downloading: "下载中", processing: "处理中",
  ready: "已就绪", committing: "正在提交", done: "已完成", failed: "失败", cancelled: "已取消"
};

function formatPixelDimensions(width?: number, height?: number) {
  return width && height ? `${width}×${height}` : "0000×0000";
}

export function ImportJobCard({ job, busy, storageDisplayName, themes, allTags, authors, onPatch, onCancel, onRetry, onRemove, onConfirmDuplicate, onOpenDetail, onPreview }: {
  job: ImportJob;
  busy: boolean;
  storageDisplayName: string;
  themes: Theme[];
  allTags: Tag[];
  authors: Author[];
  onPatch: (patch: Partial<ImageDraft>) => void;
  onCancel: () => void;
  onRetry: () => void;
  onRemove: () => void;
  onConfirmDuplicate: () => void;
  onOpenDetail: (item: ImageItem) => void;
  onPreview: () => void;
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
  const statusDetailText = job.message || statusLabels[job.status];
  const metaText = [storageDisplayName, dimensionsText, statusDetailText].filter(Boolean).join(" · ");

  return (
    <article className={`upload-job ${job.status}`}>
      <div className="upload-job-aside">
        <div className="upload-job-preview">
          {job.preview
            ? <ImageThumbnail src={job.preview} className="upload-job-thumbnail" onClick={onPreview} />
            : <div className="image-thumbnail upload-job-thumbnail" aria-hidden="true" />}
        </div>
        {isProxy
          ? (
            <span className="upload-job-size upload-proxy-note" title="代理链接图片">
              <Icon name="external-link-line" />代理链接
            </span>
          )
          : (
            <span className="upload-job-size is-vertical">
              <span>{originalSizeText}</span>
              <small>{qualityText ? `↓ ${qualityText}` : "↓"}</small>
              <span>{finalSizeText}</span>
            </span>
          )}
      </div>
      <div className="upload-job-head">
        <strong>
          <b className="import-status-label">【{statusLabels[job.status]}】</b>
          {displayName}
        </strong>
        <span className="upload-job-meta">
          {metaText}
        </span>
        {(job.status === "uploading" || job.status === "processing") && job.kind === "local" && (
          <div className="upload-progress" aria-label="上传进度"><span style={{ width: `${job.uploadProgress}%` }} /></div>
        )}
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
      {job.status === "ready" && job.duplicateDecision === "undecided" && job.duplicates.length > 0 && (
        <div className="duplicate-panel">
          <div className="duplicate-note"><strong>已存在相同的最终入库文件</strong><span>确认后可继续提交副本，或取消此任务。</span></div>
          <div className="duplicate-body">
            <div className="duplicate-list">
              {job.duplicates.map((item) => (
                <button type="button" key={item.id} className="duplicate-item" onClick={() => onOpenDetail(item)}>
                  <ImageThumbnail src={item.thumb_url} size="small" />
                  <span>{imageDisplayTitle(item)}</span><small>{formatImageMeta(item)}</small>
                </button>
              ))}
            </div>
            <div className="inline-actions">
              <button type="button" onClick={onConfirmDuplicate}>仍然提交</button>
              <button className="danger-button" type="button" onClick={onCancel}>取消</button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
