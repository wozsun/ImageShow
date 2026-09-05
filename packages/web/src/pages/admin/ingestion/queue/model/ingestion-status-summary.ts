import type {
  IngestionQueueSummaryDto,
  ServerIngestionStatusDto
} from "@imageshow/shared/browser";

export function ingestionStatusSummary(
  status: ServerIngestionStatusDto,
  duplicatePending: boolean,
  prepareWaiting: boolean
): IngestionQueueSummaryDto {
  const completed = status === "completed";
  const waiting = status === "preparing" && prepareWaiting;
  const duplicate = status === "ready" && duplicatePending;
  return {
    total: 1,
    unfinished: completed ? 0 : 1,
    waiting: ["queued", "received"].includes(status) || waiting ? 1 : 0,
    running: ["downloading", "preparing"].includes(status) && !waiting ? 1 : 0,
    ready: status === "ready" && !duplicate ? 1 : 0,
    duplicate_pending: duplicate ? 1 : 0,
    committing: status === "committing" ? 1 : 0,
    resolving: status === "resolving" ? 1 : 0,
    completed: completed ? 1 : 0,
    failed: status === "failed" ? 1 : 0
  };
}
