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
    manifestLine: owner.manifestLine,
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

export function refreshBatchDuplicateMatches(jobs: ImportJob[], ownerId: string): ImportJob[] {
  const owner = jobs.find((job) => job.id === ownerId);
  if (!owner) return jobs;
  const snapshot = batchDuplicateFromJob(owner);
  return jobs.map((job) => job.batchDuplicate?.ownerId === ownerId
    ? { ...job, batchDuplicate: snapshot }
    : job);
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
