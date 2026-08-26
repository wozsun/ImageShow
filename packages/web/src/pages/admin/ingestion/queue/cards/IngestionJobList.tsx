import { memo } from "react";
import type { FacetOption, ImageDraft, AdminImageListItem, IngestionJob } from "../../../../../lib/types.js";
import { IngestionJobCard } from "./IngestionJobCard.js";
import type { IngestionPreviewTarget } from "./DuplicateMatchPanel.js";

type IngestionJobListProps = {
  jobs: IngestionJob[];
  busy: boolean;
  storageName: (slug: string) => string;
  themes: FacetOption[];
  tags: FacetOption[];
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

export const IngestionJobList = memo(function IngestionJobList({
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
  onFocusWithin,
  onPreview
}: IngestionJobListProps) {
  return jobs.map((job) => (
    <IngestionJobCard
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
      onFocusWithin={onFocusWithin}
      onPreview={onPreview}
    />
  ));
});
