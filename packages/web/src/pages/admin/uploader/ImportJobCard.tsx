import { memo } from "react";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { ImageThumbnail } from "../../../components/image/ImageThumbnail.js";
import { ImageDraftFields } from "../../../components/form/ImageDraftFields.js";
import { importCardBrightnessSelectOptions, importCardDeviceSelectOptions } from "../../../lib/ui/select-options.js";
import { formatBytes } from "../../../lib/ui/formatters.js";
import type { FacetOption, ImageDraft, AdminImageListItem, ImportJob } from "../../../lib/types.js";
import { DuplicateMatchPanel, type ImportPreviewTarget } from "./DuplicateMatchPanel.js";
import {
  importJobNeedsDuplicateConfirmation,
  importJobPreviewAvailable
} from "./duplicate-match.js";
import {
  importAutomaticClassificationLabel,
  importJobAttributesEditable
} from "./import-attribute-policy.js";
import { importPositionText } from "./import-job-utils.js";
import {
  importJobStatusDetail,
  importJobStatusLabel
} from "./import-status-detail.js";
import {
  importJobCanBeCancelled,
  importJobCanBeRemovedLocally
} from "./import-queue-state.js";

function formatPixelDimensions(width?: number, height?: number) {
  return width && height ? `${width}×${height}` : "0000×0000";
}

function formatJobDimensions(job: ImportJob, hasFinalSize: boolean) {
  const finalDimensions = formatPixelDimensions(job.width, job.height);
  const originalDimensions = job.originalWidth && job.originalHeight
    ? formatPixelDimensions(job.originalWidth, job.originalHeight)
    : hasFinalSize
      ? "—"
      : formatPixelDimensions(job.width, job.height);
  return `${originalDimensions} → ${
    hasFinalSize ? finalDimensions : formatPixelDimensions()
  }`;
}

type ImportJobCardProps = {
  job: ImportJob;
  busy: boolean;
  storageDisplayName: string;
  themes: FacetOption[];
  allTags: FacetOption[];
  authors: FacetOption[];
  onPatch: (job: ImportJob, patch: Partial<ImageDraft>) => void;
  onCancel: (job: ImportJob) => void;
  onRetry: (job: ImportJob) => void;
  onRemove: (job: ImportJob) => void;
  onConfirmDuplicate: (job: ImportJob) => void;
  onOpenDetail: (
    job: ImportJob,
    item: AdminImageListItem,
    opener: HTMLElement
  ) => void;
  onFocusWithin: (
    job: ImportJob,
    card: HTMLElement,
    target: HTMLElement
  ) => void;
  onPreview: (target: ImportPreviewTarget) => void;
};

export const ImportJobCard = memo(function ImportJobCard({
  job,
  busy,
  storageDisplayName,
  themes,
  allTags,
  authors,
  onPatch,
  onCancel,
  onRetry,
  onRemove,
  onConfirmDuplicate,
  onOpenDetail,
  onFocusWithin,
  onPreview
}: ImportJobCardProps) {
  const editable = importJobAttributesEditable(job) && !busy;
  const cancellable = importJobCanBeCancelled(job);
  const removable = importJobCanBeRemovedLocally(job) && !cancellable;
  const cancelling = job.status === "cancelling";
  const cancellationFailed = job.failureStage === "cancel";
  const confirmDuplicate = importJobNeedsDuplicateConfirmation(job)
    && (job.duplicateCount ?? 0) > 0;
  const retryable = (
    ["failed", "cancelled"].includes(job.status)
    || (job.status === "finalized" && job.resultState === "error")
  ) && !cancellationFailed && !confirmDuplicate;
  const statusLabel = importJobStatusLabel(job);
  const hasFinalSize = typeof job.finalSize === "number";
  const originalSize = job.originalSize ?? job.file?.size;
  const hasOriginalSize = typeof originalSize === "number";
  const displayName = job.draft.title
    || job.file?.name
    || job.url
    || (job.status === "done" ? job.draft.original : "")
    || job.imageId
    || job.id;
  const originalSizeText = hasOriginalSize ? formatBytes(originalSize) : "—";
  const finalSizeText = hasFinalSize ? formatBytes(job.finalSize ?? 0) : "—";
  const dimensionsText = formatJobDimensions(job, hasFinalSize);
  const qualityText = job.quality != null
    ? String(job.quality)
    : job.transcoded === false ? "跳过转码" : "";
  const showsTransferProgress = ["uploading", "downloading"].includes(job.status)
    && typeof job.transferProgress === "number";
  const transferProgress = Math.min(100, Math.max(0, Math.round(job.transferProgress ?? 0)));
  const transferProgressLabel = job.status === "downloading" ? "下载进度" : "上传进度";
  const statusDetailText = importJobStatusDetail(job);
  const sourcePositionText = importPositionText(job);
  const metaText = [sourcePositionText, storageDisplayName, dimensionsText, statusDetailText].filter(Boolean).join(" · ");
  const sizeSummaryText = `${
    hasFinalSize && !hasOriginalSize
      ? finalSizeText
      : `${originalSizeText} → ${finalSizeText}`
  }${qualityText ? ` · ${qualityText}` : ""}`;
  const automaticClassificationLabel = importAutomaticClassificationLabel(job);
  const previewSrc = job.preview;
  const openPreview: ((opener: HTMLElement) => void) | undefined = importJobPreviewAvailable(job)
    ? (opener) => onPreview({
        jobId: job.id,
        attemptKey: job.attemptKey,
        sessionId: job.sessionId,
        imageId: job.imageId,
        src: job.previewFull || previewSrc,
        thumbSrc: previewSrc,
        width: job.width,
        height: job.height,
        opener,
      })
    : undefined;
  return (
    <article
      className={`import-job ${job.status}`}
      data-import-job-id={job.id}
      data-import-attempt-key={job.attemptKey}
      onFocusCapture={(event) => onFocusWithin(
        job,
        event.currentTarget,
        event.target as HTMLElement
      )}
    >
      <div className="import-job-aside">
        <div className="import-job-preview">
          <ImageThumbnail
            src={previewSrc}
            className="import-job-thumbnail"
            onClick={openPreview}
            showLoadingIndicator
            retainLoadedWhenEmpty={[
              "committing",
              "finalized"
            ].includes(job.status)}
          />
        </div>
        <span className="import-job-size is-vertical">
          <span>{originalSizeText}</span>
          <small>{qualityText ? `↓ ${qualityText}` : "↓"}</small>
          <span>{finalSizeText}</span>
        </span>
      </div>
      <div className="import-job-head">
        <strong>
          <b className={`import-status-label${
            confirmDuplicate ? " is-duplicate-pending" : ""
          }`}>【{statusLabel}】</b>
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
        {retryable && (
          <button
            type="button"
            className="icon"
            title={job.status === "finalized" ? "重新获取结果" : "重试"}
            onClick={() => onRetry(job)}
            disabled={busy}
          >
            <AdminIcon name="refresh-line" />
          </button>
        )}
        {cancellationFailed && (
          <button type="button" className="icon" title="重新取消" onClick={() => onCancel(job)} disabled={busy}>
            <AdminIcon name="refresh-line" />
          </button>
        )}
        {cancellable && !cancellationFailed && (
          <button type="button" className="icon danger-button" title="取消" onClick={() => onCancel(job)}>
            <AdminIcon name="close-line" />
          </button>
        )}
        {removable && !cancelling && !cancellationFailed && (
          <button type="button" className="icon danger-button" title="移除" onClick={() => onRemove(job)} disabled={busy}>
            <AdminIcon name="close-line" />
          </button>
        )}
      </div>
      <ImageDraftFields
        draft={job.draft}
        onPatch={(patch) => onPatch(job, patch)}
        themes={themes}
        allTags={allTags}
        authors={authors}
        deviceOptions={importCardDeviceSelectOptions(
          job.draft.device,
          automaticClassificationLabel
        )}
        brightnessOptions={importCardBrightnessSelectOptions(
          job.draft.brightness,
          automaticClassificationLabel
        )}
        changed={{ device: job.classificationOverride?.device, brightness: job.classificationOverride?.brightness }}
        disabled={!editable}
        ariaPrefix={job.url ?? job.file?.name ?? job.imageId ?? job.id}
      />
      {confirmDuplicate && (
        <DuplicateMatchPanel
          libraryItems={job.duplicates}
          disabled={busy}
          confirmDisabled={job.duplicates.length === 0}
          onOpenDetail={(item, opener) => onOpenDetail(job, item, opener)}
          onConfirm={() => onConfirmDuplicate(job)}
          onCancel={() => onCancel(job)}
        />
      )}
    </article>
  );
});
