import { memo } from "react";
import { AdminIcon } from "../../../../../components/icon/AdminIcon.js";
import { ImageThumbnail } from "../../../../../components/image/ImageThumbnail.js";
import { ImageDraftFields } from "../../../../../components/form/ImageDraftFields.js";
import { ingestionCardBrightnessSelectOptions, ingestionCardDeviceSelectOptions } from "../../../../../lib/ui/select-options.js";
import { formatBytes } from "../../../../../lib/ui/formatters.js";
import type { FacetOption, ImageDraft, AdminImageListItem, IngestionJob } from "../../../../../lib/types.js";
import { DuplicateMatchPanel, type IngestionPreviewTarget } from "./DuplicateMatchPanel.js";
import {
  ingestionJobNeedsDuplicateConfirmation,
  ingestionJobPreviewAvailable
} from "../model/duplicate-match.js";
import {
  ingestionAutomaticClassificationLabel,
  ingestionJobAttributesEditable
} from "../model/ingestion-attribute-policy.js";
import { importPositionText } from "../model/import-job-source.js";
import {
  ingestionJobStatusDetail,
  ingestionJobStatusLabel
} from "../model/ingestion-status-detail.js";
import {
  ingestionJobCanBeCancelled,
  ingestionJobCanBeRemovedLocally
} from "../model/ingestion-queue-state.js";
import { useIngestionJobDraftEditing } from "./useIngestionJobDraftEditing.js";

function formatPixelDimensions(width?: number, height?: number) {
  return width && height ? `${width}×${height}` : "0000×0000";
}

function formatJobDimensions(job: IngestionJob, hasFinalSize: boolean) {
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

type IngestionJobCardProps = {
  job: IngestionJob;
  busy: boolean;
  storageDisplayName: string;
  themes: FacetOption[];
  allTags: FacetOption[];
  authors: FacetOption[];
  onPatch: (job: IngestionJob, patch: Partial<ImageDraft>) => void;
  onCancel: (job: IngestionJob) => void;
  onRetry: (job: IngestionJob) => void;
  onRemove: (job: IngestionJob) => void;
  onConfirmDuplicate: (job: IngestionJob) => void;
  onOpenDetail: (
    job: IngestionJob,
    item: AdminImageListItem,
    opener: HTMLElement
  ) => void;
  onFocusWithin: (
    job: IngestionJob,
    card: HTMLElement,
    target: HTMLElement
  ) => void;
  onPreview: (target: IngestionPreviewTarget) => void;
};

export const IngestionJobCard = memo(function IngestionJobCard({
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
}: IngestionJobCardProps) {
  const editable = ingestionJobAttributesEditable(job) && !busy;
  const draftEditing = useIngestionJobDraftEditing({ job, busy, onPatch });
  const cancellable = ingestionJobCanBeCancelled(job);
  const removable = ingestionJobCanBeRemovedLocally(job) && !cancellable;
  const cancelling = job.status === "cancelling";
  const cancellationFailed = job.failureStage === "cancel";
  const confirmDuplicate = ingestionJobNeedsDuplicateConfirmation(job)
    && (job.duplicateCount ?? 0) > 0;
  const retryable = (
    ["failed", "cancelled"].includes(job.status)
    || (job.status === "finalized" && job.resultState === "error")
  ) && !cancellationFailed && !confirmDuplicate;
  const statusLabel = ingestionJobStatusLabel(job);
  const hasFinalSize = typeof job.finalSize === "number";
  const originalSize = job.originalSize ?? job.file?.size;
  const hasOriginalSize = typeof originalSize === "number";
  const displayName = draftEditing.title
    || job.file?.name
    || job.downloadUrl
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
  const statusDetailText = ingestionJobStatusDetail(job);
  const sourcePositionText = importPositionText(job);
  const metaText = [sourcePositionText, storageDisplayName, dimensionsText, statusDetailText].filter(Boolean).join(" · ");
  const sizeSummaryText = `${
    hasFinalSize && !hasOriginalSize
      ? finalSizeText
      : `${originalSizeText} → ${finalSizeText}`
  }${qualityText ? ` · ${qualityText}` : ""}`;
  const automaticClassificationLabel = ingestionAutomaticClassificationLabel(job);
  const previewSrc = job.preview;
  const openPreview: ((opener: HTMLElement) => void) | undefined = ingestionJobPreviewAvailable(job)
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
      className={`ingestion-job ${job.status}`}
      data-ingestion-job-id={job.id}
      data-ingestion-attempt-key={job.attemptKey}
      onFocusCapture={(event) => onFocusWithin(
        job,
        event.currentTarget,
        event.target as HTMLElement
      )}
    >
      <div className="ingestion-job-aside">
        <div className="ingestion-job-preview">
          <ImageThumbnail
            src={previewSrc}
            className="ingestion-job-thumbnail"
            onClick={openPreview}
            showLoadingIndicator
            retainLoadedWhenEmpty={[
              "committing",
              "finalized"
            ].includes(job.status)}
          />
        </div>
        <span className="ingestion-job-size is-vertical">
          <span>{originalSizeText}</span>
          <small>{qualityText ? `↓ ${qualityText}` : "↓"}</small>
          <span>{finalSizeText}</span>
        </span>
      </div>
      <div className="ingestion-job-head">
        <strong>
          <b className={`ingestion-status-label${
            confirmDuplicate ? " is-duplicate-pending" : ""
          }`}>【{statusLabel}】</b>
          {displayName}
        </strong>
        <span className="ingestion-job-meta">
          <span className="ingestion-job-meta-copy">{metaText}</span>
          {showsTransferProgress && (
            <output className="transfer-progress-value" aria-label={`${transferProgressLabel} ${transferProgress}%`}>
              {transferProgress}%
            </output>
          )}
        </span>
        <span className="ingestion-job-size-summary">
          {sizeSummaryText}
        </span>
      </div>
      <div className="ingestion-job-actions">
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
        deferredEditing={draftEditing.deferredEditing}
        themes={themes}
        allTags={allTags}
        authors={authors}
        deviceOptions={ingestionCardDeviceSelectOptions(
          job.draft.device,
          automaticClassificationLabel
        )}
        brightnessOptions={ingestionCardBrightnessSelectOptions(
          job.draft.brightness,
          automaticClassificationLabel
        )}
        changed={{ device: job.classificationOverride?.device, brightness: job.classificationOverride?.brightness }}
        disabled={!editable}
        ariaPrefix={job.downloadUrl ?? job.file?.name ?? job.imageId ?? job.id}
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
