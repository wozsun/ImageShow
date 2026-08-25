import type { RefObject } from "react";
import type {
  AdminImageListItemDto,
  ImportSessionPairDto,
  ImportStatusItemDto
} from "@imageshow/shared/browser";
import type { ImportJob } from "../../../lib/types.js";
import type { ImportServerBinding } from "./import-queue-state.js";

export type ImportQueueApi = {
  jobsRef: RefObject<ImportJob[]>;
  observeCompletedImports: (
    entries: readonly CompletedImportObservation[]
  ) => void;
  updateJob: (id: string, patch: Partial<ImportJob>) => void;
};

export type CompletedImportObservation = Readonly<{
  pair: ImportSessionPairDto;
  item: AdminImageListItemDto;
  completedAt?: number;
}>;

export function completedImportObservations(
  statuses: readonly ImportStatusItemDto[]
): CompletedImportObservation[] {
  return statuses.flatMap((status) => status.status === "completed"
    ? [{ pair: status, item: status.completed_item }]
    : []);
}

export type AppendImportQueueApi = ImportQueueApi & {
  appendJobs: (jobs: ImportJob[]) => boolean;
  bindServerJob: (
    id: string,
    binding: ImportServerBinding,
    requestConnectionGeneration?: number | null,
    acceptedOrder?: number
  ) => void;
  captureServerConnectionGeneration: () => number | null;
  releaseResolvedServerJobs: (targets: readonly Readonly<{
    id: string;
    attemptKey: string;
    pair: ImportSessionPairDto;
  }>[]) => ReadonlySet<string>;
  server: Readonly<{ refresh: () => void }>;
};

export function isCurrentImportAttempt(
  queue: ImportQueueApi,
  jobId: string,
  attemptKey: string
) {
  const current = queue.jobsRef.current.find((job) => job.id === jobId);
  return Boolean(
    current
      && current.attemptKey === attemptKey
      && !["cancelling", "cancelled"].includes(current.status)
  );
}
