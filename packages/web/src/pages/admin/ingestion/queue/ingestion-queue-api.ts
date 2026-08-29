import type { RefObject } from "react";
import type {
  AdminImageListItemDto,
  IngestionSessionPairDto,
  IngestionStatusItemDto
} from "@imageshow/shared/browser";
import type { IngestionJob } from "../../../../lib/types.js";
import type { IngestionServerBinding } from "./model/ingestion-queue-state.js";

export type IngestionQueueApi = {
  jobsRef: RefObject<IngestionJob[]>;
  observeCompletedIngestions: (
    entries: readonly CompletedIngestionObservation[]
  ) => void;
  updateJob: (id: string, patch: Partial<IngestionJob>) => void;
};

export type CompletedIngestionObservation = Readonly<{
  pair: IngestionSessionPairDto;
  item: AdminImageListItemDto;
  completedAt?: number;
}>;

export function completedIngestionObservations(
  statuses: readonly IngestionStatusItemDto[]
): CompletedIngestionObservation[] {
  return statuses.flatMap((status) => status.status === "completed"
    ? [{ pair: status, item: status.completed_item }]
    : []);
}

export type IngestionQueueProducerApi = IngestionQueueApi & {
  appendJobs: (jobs: IngestionJob[]) => boolean;
  bindServerJob: (
    id: string,
    binding: IngestionServerBinding,
    requestConnectionGeneration?: number | null,
    acceptedOrder?: number
  ) => void;
  captureServerConnectionGeneration: () => number | null;
  releaseResolvedServerJobs: (targets: readonly Readonly<{
    id: string;
    attemptKey: string;
    pair: IngestionSessionPairDto;
  }>[]) => ReadonlySet<string>;
  server: Readonly<{
    recoverAuthority: () => Promise<void>;
  }>;
};

export function isCurrentIngestionAttempt(
  queue: IngestionQueueApi,
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
