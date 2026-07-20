import { memo } from "react";
import type { FacetOption, ImageDraft, ImageItem, ImportJob } from "../../../lib/types.js";
import { ImportJobCard } from "./ImportJobCard.js";
import type { ImportPreviewTarget } from "./DuplicateMatchPanel.js";

type ImportJobListProps = {
  jobs: ImportJob[];
  busy: boolean;
  storageName: (slug: string) => string;
  themes: FacetOption[];
  tags: FacetOption[];
  authors: FacetOption[];
  onPatch: (job: ImportJob, patch: Partial<ImageDraft>) => void;
  onCancel: (job: ImportJob) => void;
  onRetry: (job: ImportJob) => void;
  onRemove: (job: ImportJob) => void;
  onConfirmDuplicate: (job: ImportJob) => void;
  onOpenDetail: (item: ImageItem, opener: HTMLElement) => void;
  onPreview: (target: ImportPreviewTarget) => void;
};

export const ImportJobList = memo(function ImportJobList({
  jobs,
  busy,
  storageName,
  themes,
  tags,
  authors,
  onPatch,
  onCancel,
  onRetry,
  onRemove,
  onConfirmDuplicate,
  onOpenDetail,
  onPreview
}: ImportJobListProps) {
  return jobs.map((job) => (
    <ImportJobCard
      key={job.id}
      job={job}
      busy={busy}
      storageDisplayName={storageName(job.storageSlug)}
      themes={themes}
      allTags={tags}
      authors={authors}
      onPatch={onPatch}
      onCancel={onCancel}
      onRetry={onRetry}
      onRemove={onRemove}
      onConfirmDuplicate={onConfirmDuplicate}
      onOpenDetail={onOpenDetail}
      onPreview={onPreview}
    />
  ));
});
