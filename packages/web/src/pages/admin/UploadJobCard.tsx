import { Icon } from "../../components/Icon.js";
import { ImageThumbnail } from "../../components/ImageThumbnail.js";
import { ImageDraftFields } from "../../components/ImageDraftFields.js";
import { cardBrightnessSelectOptions, cardDeviceSelectOptions } from "../../lib/select-options.js";
import { formatBytes, formatImageMeta } from "../../lib/formatters.js";
import type { Author, ImageDraft, ImageItem, Tag, Theme, UploadJob } from "../../lib/types.js";

// One upload/link job row: the thumbnail, a file- or link-specific head, the shared
// ImageDraftFields editor, and — when the image matches images already in the library —
// a duplicate panel. The same card serves both flows via job.kind, so adding a flow or a
// per-card feature stays a local change here rather than bloating the Uploader window.
export function UploadJobCard({ job, busy, themes, allTags, authors, onPatch, onRemove, onConfirmDuplicate, onOpenDetail, onPreview }: {
  job: UploadJob;
  busy: boolean;
  themes: Theme[];
  allTags: Tag[];
  authors: Author[];
  onPatch: (patch: Partial<ImageDraft>) => void;
  onRemove: () => void;
  onConfirmDuplicate: () => void;
  onOpenDetail: (item: ImageItem) => void;
  onPreview: () => void;
}) {
  const isLink = job.kind === "link";
  // Done jobs (and link jobs still downloading/finalizing) lock their fields.
  const cardDisabled = busy || job.status === "done" || (isLink && job.status !== "queued");
  return (
    <article className={`upload-job ${job.status}`}>
      <div className="upload-job-aside">
        {job.preview
          ? <ImageThumbnail src={job.preview} className="upload-job-thumbnail" onClick={onPreview} />
          : <div className="image-thumbnail upload-job-thumbnail" aria-hidden="true" />}
        {/* File jobs carry a local file size; show it under the thumbnail (links have none). */}
        {!isLink && <span className="upload-job-size">{formatBytes(job.file?.size ?? 0)}</span>}
      </div>
      <div className="upload-job-head">
        {isLink ? (
          <>
            <strong>{job.draft.title || job.url}</strong>
            <span>{job.width ? `${job.width}×${job.height}` : "下载中"} · {job.message}</span>
          </>
        ) : (
          <>
            <strong>{job.file?.name}</strong>
            <span>{job.width ? `${job.width}×${job.height}` : "—"} · {job.md5 || "md5 计算中"} · <span className={job.duplicateDecision === "upload" && job.duplicates.length > 0 && job.status === "queued" ? "dup-confirmed" : undefined}>{job.message}</span></span>
            {(job.status === "uploading" || job.status === "finalizing" || job.status === "done") && (
              <div className="upload-progress" aria-label="上传进度">
                <span style={{ width: `${job.uploadProgress}%` }} />
              </div>
            )}
          </>
        )}
      </div>
      <button
        type="button"
        className="icon danger-button"
        title="移除"
        onClick={onRemove}
        disabled={busy}
      >
        <Icon name="close-line" />
      </button>
      <ImageDraftFields
        draft={job.draft}
        onPatch={onPatch}
        themes={themes}
        allTags={allTags}
        authors={authors}
        deviceOptions={cardDeviceSelectOptions}
        brightnessOptions={cardBrightnessSelectOptions}
        disabled={cardDisabled}
        ariaPrefix={isLink ? (job.url ?? job.id) : (job.file?.name ?? job.id)}
      />
      {job.duplicateDecision === "undecided" && !!job.duplicates.length && (
        <div className="duplicate-panel">
          <div className="duplicate-note">
            <strong>已存在相同图片</strong>
            <span>{isLink ? "确认后可继续导入，或移除此链接。" : "确认后可继续上传副本，或移除此文件。"}</span>
          </div>
          <div className="duplicate-body">
            <div className="duplicate-list">
              {job.duplicates.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className="duplicate-item"
                  onClick={() => onOpenDetail(item)}
                >
                  <ImageThumbnail src={item.thumb_url} size="small" />
                  <span>{item.title || item.index_key}</span>
                  <small>{formatImageMeta(item)}</small>
                </button>
              ))}
            </div>
            <div className="inline-actions">
              <button type="button" onClick={onConfirmDuplicate}>{isLink ? "仍然导入" : "仍然上传"}</button>
              <button className="danger-button" type="button" onClick={onRemove}>移除</button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
