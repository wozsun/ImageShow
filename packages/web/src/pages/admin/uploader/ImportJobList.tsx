import { memo, useMemo } from "react";
import type { FacetOption, ImageDraft, AdminImageListItem, ImportJob } from "../../../lib/types.js";
import { ImportJobCard } from "./ImportJobCard.js";
import type { ImportPreviewTarget } from "./DuplicateMatchPanel.js";
import { queueDuplicateReferences } from "./duplicate-match.js";

type ImportJobListProps = {
  jobs: ImportJob[];
  allJobs: ImportJob[];
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
  onOpenDetail: (item: AdminImageListItem, opener: HTMLElement) => void;
  onPreview: (target: ImportPreviewTarget) => void;
};

export const ImportJobList = memo(function ImportJobList({
  jobs,
  allJobs,
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
  const queueDuplicates = useMemo(
    () => queueDuplicateReferences(allJobs),
    [allJobs]
  );
  return jobs.map((job) => (
    <ImportJobCard
      key={job.id}
      job={job}
      queueDuplicate={queueDuplicates.get(job.id)}
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
