import { importStatusBatchMaxItems } from "@imageshow/shared/browser";
import type { ImportJob } from "../../../lib/types.js";

const terminalStatuses = new Set<ImportJob["status"]>([
  "ready",
  "cancelling",
  "done",
  "failed",
  "cancelled"
]);

function importStatusChunks<T>(items: readonly T[]) {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += importStatusBatchMaxItems) {
    result.push(items.slice(offset, offset + importStatusBatchMaxItems));
  }
  return result;
}

type ImportStatusGenerationMember = {
  batchKey: string;
  attemptKey: string;
};

export type ImportStatusGeneration = ReadonlyMap<
  string,
  ImportStatusGenerationMember
>;

function sameImportStatusGeneration(
  left: ImportStatusGeneration,
  right: ImportStatusGeneration
) {
  return left.size === right.size && [...left].every(
    ([jobId, member]) => {
      const candidate = right.get(jobId);
      return candidate?.batchKey === member.batchKey
        && candidate.attemptKey === member.attemptKey;
    }
  );
}

export function advanceImportStatusGeneration(
  currentGeneration: ImportStatusGeneration,
  jobs: readonly ImportJob[]
) {
  const activeJobs = jobs.filter(importJobAcceptsStatus);
  if (activeJobs.length === 0) {
    return currentGeneration.size === 0 ? currentGeneration : new Map();
  }

  const activeBatchKeys = new Set(
    activeJobs.map((job) => job.subscriptionBatchKey)
  );
  const currentJobs = new Map(jobs.map((job) => [job.id, job]));
  const nextGeneration = new Map<string, ImportStatusGenerationMember>();
  for (const [jobId, member] of currentGeneration) {
    const currentJob = currentJobs.get(jobId);
    if (
      currentJob?.subscriptionBatchKey === member.batchKey
      && activeBatchKeys.has(member.batchKey)
    ) {
      nextGeneration.set(jobId, member);
    }
  }
  for (const job of activeJobs) {
    nextGeneration.set(job.id, {
      batchKey: job.subscriptionBatchKey,
      attemptKey: job.attemptKey.toLowerCase()
    });
  }
  return sameImportStatusGeneration(currentGeneration, nextGeneration)
    ? currentGeneration
    : nextGeneration;
}

export type ImportStatusSubscriptionSpec = {
  key: string;
  jobIds: readonly string[];
  attemptKeys: readonly string[];
};

export function importStatusGenerationSubscriptions(
  generation: ImportStatusGeneration
): ImportStatusSubscriptionSpec[] {
  const membersByBatch = new Map<
    string,
    Array<[jobId: string, attemptKey: string]>
  >();
  for (const [jobId, member] of generation) {
    const members = membersByBatch.get(member.batchKey) ?? [];
    members.push([jobId, member.attemptKey]);
    membersByBatch.set(member.batchKey, members);
  }
  return [...membersByBatch]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([batchKey, members]) => importStatusChunks(
      members.sort(([left], [right]) => left.localeCompare(right))
    ).map((chunk, index) => ({
      key: `${batchKey}:${index}`,
      jobIds: chunk.map(([jobId]) => jobId),
      attemptKeys: [...new Set(
        chunk.map(([, attemptKey]) => attemptKey)
      )].sort()
    })));
}

export function activeImportSessionIds(jobs: readonly ImportJob[]) {
  return [...new Set(
    jobs
      .filter((job) => job.sessionId && !terminalStatuses.has(job.status))
      .map((job) => job.sessionId!.toLowerCase())
  )].sort();
}

export function importJobAcceptsStatus(job: ImportJob) {
  return !terminalStatuses.has(job.status);
}
