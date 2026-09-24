import type {
  IngestionQueueSummaryDto,
  IngestionSessionPairDto,
  ServerIngestionItemDto
} from "@imageshow/shared/browser";
import type { IngestionJob } from "./ingestion-job.js";
import {
  ingestionJobHasServerAuthority,
  serverIngestionJobPairKey,
  serverIngestionPairKey
} from "./server-ingestion-job.js";
import { ingestionStatusSummary } from "./ingestion-status-summary.js";

export type ResolvedServerJobTarget = Readonly<{
  id: string;
  attemptKey: string;
  pair: IngestionSessionPairDto;
  releasedRevision?: number;
  releasedSummary?: IngestionQueueSummaryDto;
}>;

export function ingestionJobMatchesResolvedServerTarget(
  job: IngestionJob,
  target: ResolvedServerJobTarget
) {
  if (serverIngestionJobPairKey(job) !== serverIngestionPairKey(target.pair)) {
    return false;
  }
  if (job.id === target.id && job.attemptKey === target.attemptKey) return true;
  return ingestionJobHasServerAuthority(job)
    && job.serverAttemptKey === target.attemptKey;
}

function serverItemSummary(item: ServerIngestionItemDto): IngestionQueueSummaryDto {
  return ingestionStatusSummary(
    item.status,
    item.status === "ready" && Boolean(item.prepared?.duplicate_count) && !item.duplicate_decision,
    item.status === "preparing" && item.phase === "prepare-waiting"
  );
}

export function withoutReleasedServerSummaries(
  summary: IngestionQueueSummaryDto,
  releasedSummaries: readonly IngestionQueueSummaryDto[]
): IngestionQueueSummaryDto {
  if (!releasedSummaries.length) return summary;
  const released = releasedSummaries.reduce<IngestionQueueSummaryDto>(
    (counts, item) => ({
      total: counts.total + item.total,
      unfinished: counts.unfinished + item.unfinished,
      waiting: counts.waiting + item.waiting,
      running: counts.running + item.running,
      ready: counts.ready + item.ready,
      duplicate_pending: counts.duplicate_pending + item.duplicate_pending,
      committing: counts.committing + item.committing,
      resolving: counts.resolving + item.resolving,
      completed: counts.completed + item.completed,
      failed: counts.failed + item.failed
    }),
    {
      total: 0,
      unfinished: 0,
      waiting: 0,
      running: 0,
      ready: 0,
      duplicate_pending: 0,
      committing: 0,
      resolving: 0,
      completed: 0,
      failed: 0
    }
  );
  const subtract = (value: number, amount: number) => Math.max(0, value - amount);
  return {
    total: subtract(summary.total, released.total),
    unfinished: subtract(summary.unfinished, released.unfinished),
    waiting: subtract(summary.waiting, released.waiting),
    running: subtract(summary.running, released.running),
    ready: subtract(summary.ready, released.ready),
    duplicate_pending: subtract(
      summary.duplicate_pending,
      released.duplicate_pending
    ),
    committing: subtract(summary.committing, released.committing),
    resolving: subtract(summary.resolving, released.resolving),
    completed: subtract(summary.completed, released.completed),
    failed: subtract(summary.failed, released.failed)
  };
}

export type ResolvedReleaseProjectionContext = Readonly<{
  hasRetainedServerBaseline: boolean;
  serverItems: readonly ServerIngestionItemDto[];
  retainedServerSummary: IngestionQueueSummaryDto | null;
  retainedServerRevision: number | null;
  localJobs: readonly IngestionJob[];
  provisionalSummaryJobs: readonly IngestionJob[];
}>;

export function releasedServerSummariesForTargets(
  context: Pick<
    ResolvedReleaseProjectionContext,
    "hasRetainedServerBaseline" | "serverItems" | "retainedServerRevision"
  >,
  targets: ReadonlyMap<string, ResolvedServerJobTarget>
) {
  const snapshotItemsByPair = context.hasRetainedServerBaseline
    ? new Map(context.serverItems.map((item) => [serverIngestionPairKey(item), item] as const))
    : new Map<string, ServerIngestionItemDto>();
  return [...targets].flatMap(([pairKey, target]) => {
    const snapshotItem = snapshotItemsByPair.get(pairKey);
    if (snapshotItem) return [serverItemSummary(snapshotItem)];
    return target.releasedSummary &&
      target.releasedRevision !== undefined &&
      context.retainedServerRevision !== null &&
      context.retainedServerRevision < target.releasedRevision
      ? [target.releasedSummary]
      : [];
  });
}

export function projectedTotalAfterResolvedRelease(
  context: ResolvedReleaseProjectionContext,
  currentTargets: ReadonlyMap<string, ResolvedServerJobTarget>,
  releasedTargets: ReadonlyMap<string, ResolvedServerJobTarget>
) {
  const projectedTargets = new Map(currentTargets);
  for (const [pairKey, target] of releasedTargets) {
    projectedTargets.set(pairKey, target);
  }
  const projectedServerSummary = context.retainedServerSummary
    ? withoutReleasedServerSummaries(
        context.retainedServerSummary,
        releasedServerSummariesForTargets(context, projectedTargets)
      )
    : null;
  const retainedLocalJobs = context.localJobs.filter((job) => {
    const target = projectedTargets.get(serverIngestionJobPairKey(job));
    return !target || !ingestionJobMatchesResolvedServerTarget(job, target);
  });
  const retainedProvisionalJobs = context.provisionalSummaryJobs.filter((job) => {
    const target = projectedTargets.get(serverIngestionJobPairKey(job));
    return !target || !ingestionJobMatchesResolvedServerTarget(job, target);
  });
  return (
    retainedLocalJobs.length + retainedProvisionalJobs.length + (projectedServerSummary?.total ?? 0)
  );
}
