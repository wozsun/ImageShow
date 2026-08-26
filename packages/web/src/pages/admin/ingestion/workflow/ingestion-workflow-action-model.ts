import type { IngestionJob } from "../../../../lib/types.js";
import type { IngestionQueueCancelOutcome } from "../queue/ingestion-cancel.js";
import { ingestionJobNeedsDuplicateConfirmation } from "../queue/model/duplicate-match.js";
import { isUncommittedIngestionJob } from "../queue/model/ingestion-queue-state.js";
import type { FrozenIngestionQueueAction } from "../queue/useIngestionQueueActions.js";
import type { IngestionQueueController } from "../queue/useIngestionQueue.js";
import type { IngestionCleanupActionId } from "./ingestion-cleanup-actions.js";

export type CapturedLocalJob = Readonly<IngestionJob>;

export type CapturedServerAction =
  | Readonly<{ frozen: null; required: false }>
  | Readonly<{
      frozen: FrozenIngestionQueueAction | null;
      required: true;
    }>;

export type UnresolvedLocalClear = Readonly<{
  id: string;
  attemptKey: string;
  outcome?: IngestionQueueCancelOutcome;
}>;

export type LocalClearResult = Readonly<{
  unresolved: readonly UnresolvedLocalClear[];
}>;

export type FrozenLocalClearIntent = Readonly<{
  queueType: "upload" | "import";
  serverAction: CapturedServerAction;
  localJobs: readonly CapturedLocalJob[];
  unresolvedLocal: LocalClearResult;
  retryable: boolean;
}>;

export type FrozenClearQueueIntent = FrozenLocalClearIntent;

export type FrozenCleanupIntent = FrozenLocalClearIntent & Readonly<{
  action: IngestionCleanupActionId;
  count: number;
}>;

export type DeferredCompletedCleanup = {
  id: number;
  maxSemanticRevision: number;
  localJobs: readonly CapturedLocalJob[];
  unresolvedLocal: LocalClearResult;
  releaseConnection: () => void;
  running: boolean;
  retryAfterAuthority?: Readonly<{
    connectionGeneration: number;
    revision: number | null;
  }>;
};

export function retainUnresolvedLocalJobs(
  captured: readonly CapturedLocalJob[],
  result: LocalClearResult
) {
  if (!result.unresolved.length) return [];
  const unresolvedAttempts = new Set(result.unresolved.map(
    (item) => `${item.id}\0${item.attemptKey}`
  ));
  return captured.filter((job) => (
    unresolvedAttempts.has(`${job.id}\0${job.attemptKey}`)
  ));
}

export function preserveUnresolvedLocalOutcomes(
  current: LocalClearResult,
  previous: LocalClearResult
) {
  if (!current.unresolved.length || !previous.unresolved.length) return current;
  const previousByAttempt = new Map(previous.unresolved.map((item) => (
    [`${item.id}\0${item.attemptKey}`, item] as const
  )));
  return {
    unresolved: current.unresolved.map((item) => (
      item.outcome
        ? item
        : previousByAttempt.get(`${item.id}\0${item.attemptKey}`) ?? item
    ))
  } satisfies LocalClearResult;
}

export function cleanupActionType(action: IngestionCleanupActionId) {
  if (action === "duplicates") return "clear_duplicate_pending" as const;
  if (action === "uncommitted") return "clear_uncommitted" as const;
  return "clear_completed" as const;
}

export function cleanupLocalPredicate(action: IngestionCleanupActionId) {
  if (action === "duplicates") return ingestionJobNeedsDuplicateConfirmation;
  if (action === "uncommitted") return isUncommittedIngestionJob;
  return (job: IngestionJob) => job.status === "done";
}

export function serverIntentMatchesQueue(
  action: CapturedServerAction,
  status: IngestionQueueController["server"]["status"],
  connectionGeneration: number,
  actionScope: string
) {
  if (!action.required) return true;
  const frozen = action.frozen;
  return frozen !== null && (
    status === "ready"
    && frozen.connectionGeneration === connectionGeneration
    && frozen.actionScope === actionScope
  );
}
