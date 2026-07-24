import type { BatchDuplicateMatch, ImportJob } from "../../../lib/types.js";
import { importPositionText } from "./import-job-utils.js";

function batchDuplicatePreviewAvailable(owner: ImportJob) {
  const previewFull = owner.previewFull || owner.preview;
  const previewReadable = owner.previewPersistent
    || ["ready", "committing"].includes(owner.status);
  return Boolean(owner.preview && previewFull && previewReadable);
}

function batchDuplicateFromJob(owner: ImportJob): BatchDuplicateMatch {
  const previewFull = owner.previewFull || owner.preview;
  return {
    ownerId: owner.id,
    manifestSource: owner.manifestSource,
    manifestLine: owner.manifestLine,
    manifestPosition: owner.manifestPosition,
    original: owner.url
      || owner.file?.webkitRelativePath
      || owner.file?.name
      || owner.draft.original
      || owner.id,
    preview: owner.preview,
    previewFull,
    width: owner.width,
    height: owner.height,
    device: owner.draft.device,
    brightness: owner.draft.brightness,
    theme: owner.draft.theme,
    available: batchDuplicatePreviewAvailable(owner)
  };
}

export function preparedBatchDuplicateMatch(
  jobs: readonly ImportJob[],
  currentId: string,
  md5: string
) {
  const candidates = jobs.filter((job) => (
    job.id !== currentId
    && job.md5 === md5
  ));
  const detached = candidates
    .map((job) => job.batchDuplicate)
    .find((match) => match?.ownerId === null);
  if (detached) return detached;
  const owner = candidates.find((job) => !job.batchDuplicate)
    ?? candidates[0];
  return owner ? batchDuplicateFromJob(owner) : undefined;
}

export function importDuplicateMessage(
  libraryCount: number,
  batchDuplicate?: BatchDuplicateMatch
) {
  const batchPosition = batchDuplicate ? importPositionText(batchDuplicate) : "";
  if (libraryCount && batchDuplicate) {
    return batchPosition
      ? `与图库中 ${libraryCount} 张图片及${batchPosition}的最终文件重复`
      : `与图库中 ${libraryCount} 张图片及同批任务的最终文件重复`;
  }
  if (libraryCount) return `与图库中 ${libraryCount} 张图片的最终文件重复`;
  if (batchDuplicate) {
    return batchPosition
      ? `与${batchPosition}的最终文件重复`
      : "与同批任务的最终文件重复";
  }
  return "已就绪，待提交";
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
    || previous.draft.theme !== next.draft.theme
    || batchDuplicatePreviewAvailable(previous) !== batchDuplicatePreviewAvailable(next);
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

function withBatchDuplicate(
  job: ImportJob,
  batchDuplicate: BatchDuplicateMatch | undefined
): ImportJob {
  if (job.status !== "ready") {
    return { ...job, batchDuplicate };
  }
  const previousDuplicateExists = job.duplicates.length > 0
    || Boolean(job.batchDuplicate);
  const duplicateExists = job.duplicates.length > 0
    || Boolean(batchDuplicate);
  const duplicateDecision = !previousDuplicateExists && duplicateExists
    ? "undecided"
    : job.duplicateDecision === "undecided" && !duplicateExists
      ? "upload"
      : job.duplicateDecision;
  if (
    duplicateDecision === job.duplicateDecision
    && duplicateDecision !== "undecided"
    && duplicateExists
  ) {
    return { ...job, batchDuplicate };
  }
  return {
    ...job,
    batchDuplicate,
    duplicateDecision,
    message: importDuplicateMessage(job.duplicates.length, batchDuplicate)
  };
}

export function detachRemovedBatchDuplicateOwners(
  jobs: ImportJob[],
  removedIds: Set<string>
): ImportJob[] {
  const removed = jobs.filter((job) => removedIds.has(job.id));
  const remaining = jobs.filter((job) => !removedIds.has(job.id));
  const removedById = new Map(removed.map((job) => [job.id, job]));
  const resolutions = new Map<string, {
    canonical?: ImportJob;
    detached?: BatchDuplicateMatch;
  }>();

  for (const owner of removed) {
    if (!owner.md5 || resolutions.has(owner.md5)) continue;
    const group = remaining.filter((job) => (
      job.md5 === owner.md5
      && !["cancelling", "cancelled"].includes(job.status)
    ));
    const detached = [
      ...removed
        .filter((job) => job.md5 === owner.md5)
        .map((job) => job.batchDuplicate),
      ...group.map((job) => job.batchDuplicate)
    ].find((match) => match?.ownerId === null);
    if (detached) {
      resolutions.set(owner.md5, { detached });
      continue;
    }
    const removedDoneOwner = removed.find((job) => (
      job.md5 === owner.md5
      && job.status === "done"
      && job.previewPersistent
    )) ?? removed.find((job) => (
      job.md5 === owner.md5 && job.status === "done"
    ));
    if (removedDoneOwner) {
      const snapshot = batchDuplicateFromJob(removedDoneOwner);
      resolutions.set(owner.md5, {
        detached: removedDoneOwner.previewPersistent
          ? { ...snapshot, ownerId: null }
          : {
              ...snapshot,
              ownerId: null,
              preview: "",
              previewFull: "",
              available: false
            }
      });
      continue;
    }
    const canonical = group.find((job) => !job.batchDuplicate)
      ?? group[0];
    resolutions.set(owner.md5, { canonical });
  }

  return remaining.map((job) => {
    const currentMatch = job.batchDuplicate;
    const ownerId = currentMatch?.ownerId;
    const resolution = job.md5 ? resolutions.get(job.md5) : undefined;
    if (resolution?.detached) {
      return withBatchDuplicate(job, resolution.detached);
    }
    if (resolution?.canonical) {
      return withBatchDuplicate(
        job,
        resolution.canonical.id === job.id
          ? undefined
          : batchDuplicateFromJob(resolution.canonical)
      );
    }
    if (!currentMatch || !ownerId || !removedIds.has(ownerId)) return job;
    const owner = removedById.get(ownerId);
    if (owner?.status === "done" && owner.previewPersistent) {
      return withBatchDuplicate(job, {
        ...batchDuplicateFromJob(owner),
        ownerId: null
      });
    }
    return withBatchDuplicate(job, {
      ...(owner ? batchDuplicateFromJob(owner) : currentMatch),
      ownerId: null,
      preview: "",
      previewFull: "",
      available: false
    });
  });
}
