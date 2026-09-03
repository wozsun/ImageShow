import { createHash } from "node:crypto";
import type { IngestionQueueSummaryDto } from "@imageshow/shared/browser";
import type {
  IngestionSessionSnapshot,
  IngestionQueueMetadata,
  IngestionQueueSummary,
  StoredIngestionSession
} from "./model.ts";

type IngestionSessionProjection = IngestionQueueSummary;

export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(
      (key) => record[key] !== undefined
    ).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function semanticIngestionSessionHash(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function ingestionSessionSemanticHash(
  session: Omit<IngestionSessionSnapshot, "semantic_hash"> | IngestionSessionSnapshot
) {
  const {
    semantic_hash: _semanticHash,
    version: _version,
    progress_seq: _progressSequence,
    last_semantic_revision: _lastSemanticRevision,
    discard_at: _discardAt,
    accepted_at: _acceptedAt,
    accepted_order: _acceptedOrder,
    phase: _phase,
    message: _message,
    progress: _progress,
    ...semantic
  } = session as IngestionSessionSnapshot & {
    phase?: string;
    message?: string;
    progress?: number | null;
  };
  return semanticIngestionSessionHash(semantic);
}

export function queueProjectionForSession(
  session: StoredIngestionSession
): IngestionSessionProjection {
  if (session.status === "discarded") {
    return {
      total: 0,
      unfinished: 0,
      waiting: 0,
      running: 0,
      ready: 0,
      duplicate_pending: 0,
      committing_resolving: 0,
      resolving: 0,
      completed: 0,
      failed: 0
    };
  }
  const completed = session.status === "completed" ? 1 : 0;
  const prepareWaiting = session.status === "preparing"
    && session.phase === "prepare-waiting";
  const duplicatePending = session.status === "ready"
    && "prepared" in session
    && Boolean(session.prepared?.duplicate_count)
    && !session.duplicate_decision;
  return {
    total: 1,
    unfinished: completed ? 0 : 1,
    waiting: ["queued", "received"].includes(session.status) || prepareWaiting
      ? 1
      : 0,
    running: ["downloading", "preparing"].includes(session.status)
      && !prepareWaiting
      ? 1
      : 0,
    ready: session.status === "ready" && !duplicatePending ? 1 : 0,
    duplicate_pending: duplicatePending ? 1 : 0,
    committing_resolving: ["committing", "resolving"].includes(session.status)
      ? 1
      : 0,
    resolving: session.status === "resolving" ? 1 : 0,
    completed,
    failed: session.status === "failed" ? 1 : 0
  };
}

export function ingestionQueueSummaryDifference(
  previous: IngestionQueueSummary,
  next: IngestionQueueSummary
) {
  return Object.fromEntries(Object.keys(previous).map((key) => [
    key,
    next[key as keyof IngestionQueueSummary]
      - previous[key as keyof IngestionQueueSummary]
  ])) as unknown as IngestionQueueSummary;
}

export function presentIngestionQueueSummary(
  metadata: IngestionQueueMetadata
): IngestionQueueSummaryDto {
  return {
    total: metadata.total,
    unfinished: metadata.unfinished,
    waiting: metadata.waiting,
    running: metadata.running,
    ready: metadata.ready,
    duplicate_pending: metadata.duplicate_pending,
    committing: metadata.committing_resolving - metadata.resolving,
    resolving: metadata.resolving,
    completed: metadata.completed,
    failed: metadata.failed
  };
}
