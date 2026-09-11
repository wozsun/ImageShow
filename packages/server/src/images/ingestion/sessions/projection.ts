import { createHash } from "node:crypto";
import type { IngestionQueueSummaryDto } from "@imageshow/shared/browser";
import type {
  IngestionSessionSnapshot,
  IngestionQueueMetadata
} from "./model.ts";

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
