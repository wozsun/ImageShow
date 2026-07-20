import type { BatchDuplicateMatch, ImportJob } from "../../../lib/types.js";

export type PreparedMd5Claim =
  | { claimed: true }
  | { claimed: false; ownerId: string };

export function claimPreparedMd5Owner(
  owners: Map<string, string>,
  id: string,
  md5: string
): PreparedMd5Claim {
  const ownerId = owners.get(md5);
  if (ownerId && ownerId !== id) return { claimed: false, ownerId };
  owners.set(md5, id);
  return { claimed: true };
}

export function releasePreparedMd5Owner(
  owners: Map<string, string>,
  id: string,
  md5: string
) {
  if (owners.get(md5) !== id) return false;
  owners.delete(md5);
  return true;
}

export function batchDuplicateFromJob(owner: ImportJob): BatchDuplicateMatch {
  const previewFull = owner.previewFull || owner.preview;
  return {
    ownerId: owner.id,
    manifestSource: owner.manifestSource,
    manifestLine: owner.manifestLine,
    manifestPosition: owner.manifestPosition,
    original: owner.url || owner.draft.original,
    preview: owner.preview,
    previewFull,
    width: owner.width,
    height: owner.height,
    device: owner.draft.device,
    brightness: owner.draft.brightness,
    theme: owner.draft.theme,
    available: Boolean(owner.preview && previewFull)
  };
}

export function batchDuplicateSnapshotChanged(previous: ImportJob, next: ImportJob) {
  return previous.manifestSource !== next.manifestSource
    || previous.manifestLine !== next.manifestLine
    || previous.manifestPosition !== next.manifestPosition
    || (previous.url || previous.draft.original) !== (next.url || next.draft.original)
    || previous.preview !== next.preview
    || (previous.previewFull || previous.preview) !== (next.previewFull || next.preview)
    || previous.width !== next.width
    || previous.height !== next.height
    || previous.draft.device !== next.draft.device
    || previous.draft.brightness !== next.draft.brightness
    || previous.draft.theme !== next.draft.theme;
}

export function refreshBatchDuplicateMatchesForOwners(
  jobs: ImportJob[],
  ownerIds: ReadonlySet<string>
): ImportJob[] {
  if (!ownerIds.size) return jobs;
  const owners = new Map<string, ImportJob>();
  for (const job of jobs) {
    if (ownerIds.has(job.id)) owners.set(job.id, job);
  }
  if (!owners.size) return jobs;

  let changed = false;
  const nextJobs = jobs.map((job) => {
    const ownerId = job.batchDuplicate?.ownerId;
    const owner = ownerId ? owners.get(ownerId) : undefined;
    if (!owner) return job;
    changed = true;
    return { ...job, batchDuplicate: batchDuplicateFromJob(owner) };
  });
  return changed ? nextJobs : jobs;
}

export function refreshBatchDuplicateMatches(jobs: ImportJob[], ownerId: string): ImportJob[] {
  return refreshBatchDuplicateMatchesForOwners(jobs, new Set([ownerId]));
}

export function detachRemovedBatchDuplicateOwners(
  jobs: ImportJob[],
  removedIds: Set<string>
): ImportJob[] {
  const removed = new Map(
    jobs.filter((job) => removedIds.has(job.id)).map((job) => [job.id, job])
  );
  return jobs
    .filter((job) => !removedIds.has(job.id))
    .map((job) => {
      const currentMatch = job.batchDuplicate;
      const ownerId = currentMatch?.ownerId;
      if (!currentMatch || !ownerId || !removedIds.has(ownerId)) return job;
      const owner = removed.get(ownerId);
      const hasStablePreview = Boolean(
        owner && (owner.status === "done" || owner.duplicates.length > 0)
      );
      return {
        ...job,
        batchDuplicate: hasStablePreview
          ? { ...batchDuplicateFromJob(owner!), ownerId: null }
          : {
              ...currentMatch,
              ownerId: null,
              preview: "",
              previewFull: "",
              available: false
            }
      };
    });
}
