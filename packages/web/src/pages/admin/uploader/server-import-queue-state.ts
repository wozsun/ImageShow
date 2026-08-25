import type {
  ImportQueueEventDto,
  ImportQueueSnapshotDto,
  ImportQueueSummaryDto,
  ImportSessionPairDto,
  ServerImportItemDto
} from "@imageshow/shared/browser";

export type ServerImportQueueBaseline = Readonly<{
  revision: number;
  lastAcceptedOrder: number;
  summary: ImportQueueSummaryDto;
  items: readonly ServerImportItemDto[];
  staleItems: readonly ImportSessionPairDto[];
  actionWatermark: string;
}>;

export type ImportQueueMutationMerge =
  | { kind: "accepted"; baseline: ServerImportQueueBaseline }
  | { kind: "ignored"; baseline: ServerImportQueueBaseline }
  | { kind: "reload"; baseline: ServerImportQueueBaseline };

export type ImportQueueSnapshotSelection = Readonly<{
  offset: number;
  limit: number;
  requiredItems: number;
  excludeItems: readonly ImportSessionPairDto[];
  includeItems: readonly ImportSessionPairDto[];
}>;

export function baselineFromImportSnapshot(
  snapshot: ImportQueueSnapshotDto
): ServerImportQueueBaseline {
  return {
    revision: snapshot.revision,
    lastAcceptedOrder: snapshot.last_accepted_order,
    summary: {
      total: snapshot.total,
      unfinished: snapshot.unfinished,
      waiting: snapshot.waiting,
      running: snapshot.running,
      ready: snapshot.ready,
      duplicate_pending: snapshot.duplicate_pending,
      committing: snapshot.committing,
      resolving: snapshot.resolving,
      completed: snapshot.completed,
      failed: snapshot.failed
    },
    items: snapshot.items,
    staleItems: snapshot.stale_items ?? [],
    actionWatermark: snapshot.action_watermark
  };
}

function pairMatches(
  left: Pick<ServerImportItemDto, "session_id" | "image_id">,
  right: Pick<ServerImportItemDto, "session_id" | "image_id">
) {
  return left.session_id === right.session_id
    && left.image_id.toLowerCase() === right.image_id.toLowerCase();
}

function pairKey(pair: ImportSessionPairDto) {
  return `${pair.session_id}\0${pair.image_id.toLowerCase()}`;
}

/**
 * Decide whether a captured page also covers a later selection. Browser-owned
 * pairs normally enter exclude/include together a few milliseconds after the
 * SSE mutation that caused the snapshot. Re-reading is unnecessary when the
 * captured page already contains every newly selected pair and either still
 * has enough ordinary rows for the actual display slots or had reached the
 * end of the queue. The request may deliberately retain more rows as a
 * bounded reservoir; refilling that reservoir alone is not a read reason.
 */
export function importQueueBaselineCoversSelection(
  baseline: ServerImportQueueBaseline,
  captured: ImportQueueSnapshotSelection,
  requested: ImportQueueSnapshotSelection
) {
  if (
    requested.offset !== captured.offset
    || requested.limit > captured.limit
  ) return false;

  const capturedExclude = new Set(captured.excludeItems.map(pairKey));
  const capturedInclude = new Set(captured.includeItems.map(pairKey));
  const requestedExclude = new Set(requested.excludeItems.map(pairKey));
  const requestedInclude = new Set(requested.includeItems.map(pairKey));
  const sameExclude = capturedExclude.size === requestedExclude.size
    && [...capturedExclude].every((key) => requestedExclude.has(key));
  const sameInclude = capturedInclude.size === requestedInclude.size
    && [...capturedInclude].every((key) => requestedInclude.has(key));
  if (
    sameExclude
    && sameInclude
    && requested.requiredItems <= captured.requiredItems
  ) return true;
  if (!sameExclude || !sameInclude) {
    if (
      [...capturedExclude].some((key) => !requestedExclude.has(key))
      || [...capturedInclude].some((key) => !requestedInclude.has(key))
    ) return false;

    const itemKeys = new Set(baseline.items.map(pairKey));
    if (
      [...requestedExclude].some((key) => (
        !capturedExclude.has(key) && !itemKeys.has(key)
      ))
      || [...requestedInclude].some((key) => (
        !capturedInclude.has(key) && !itemKeys.has(key)
      ))
    ) return false;
  }

  const capturedNormalCount = baseline.items.filter((item) => (
    !capturedExclude.has(pairKey(item))
  )).length;
  const requestedNormalCount = baseline.items.filter((item) => (
    !requestedExclude.has(pairKey(item))
  )).length;
  if (requestedNormalCount >= requested.requiredItems) return true;

  const staleKeys = new Set(baseline.staleItems.map(pairKey));
  const activeCapturedExclusions = [...capturedExclude].filter((key) => (
    !staleKeys.has(key)
  )).length;
  const capturedFilteredTotal = Math.max(
    0,
    baseline.summary.total - activeCapturedExclusions
  );
  return captured.offset + capturedNormalCount >= capturedFilteredTotal;
}

function replaceItem(
  baseline: ServerImportQueueBaseline,
  index: number,
  event: Extract<ImportQueueEventDto, { type: "mutation" }>
) {
  if (!("queue" in event.session)) return null;
  const items = [...baseline.items];
  items[index] = event.session;
  return {
    revision: event.revision,
    lastAcceptedOrder: event.last_accepted_order,
    summary: event.summary,
    items,
    staleItems: baseline.staleItems,
    actionWatermark: event.action_watermark ?? baseline.actionWatermark
  } satisfies ServerImportQueueBaseline;
}

/**
 * Merge one live event into a page captured by a stable snapshot. A semantic
 * gap or any membership change invalidates only this bounded page; progress
 * may skip sequence numbers but can never cross a session version.
 */
export function mergeImportQueueMutation(
  baseline: ServerImportQueueBaseline,
  event: Extract<ImportQueueEventDto, { type: "mutation" }>
): ImportQueueMutationMerge {
  const index = baseline.items.findIndex((item) => (
    item.session_id === event.session.session_id
  ));
  const current = index < 0 ? undefined : baseline.items[index];

  if (event.kind === "progress") {
    if (event.revision > baseline.revision) {
      return { kind: "reload", baseline };
    }
    if (!current) return { kind: "ignored", baseline };
    if (!pairMatches(current, event.session)) {
      return { kind: "reload", baseline };
    }
    if (event.session.version < current.version) {
      return { kind: "ignored", baseline };
    }
    if (event.session.version > current.version) {
      return { kind: "reload", baseline };
    }
    if (event.session.progress_seq <= current.progress_seq) {
      return { kind: "ignored", baseline };
    }
    const replacement = replaceItem(baseline, index, event);
    const next = replacement && {
      ...replacement,
      revision: baseline.revision,
      lastAcceptedOrder: baseline.lastAcceptedOrder,
      summary: baseline.summary,
      actionWatermark: baseline.actionWatermark
    };
    return next
      ? { kind: "accepted", baseline: next }
      : { kind: "reload", baseline };
  }

  if (event.revision < baseline.revision) {
    return { kind: "ignored", baseline };
  }
  if (event.revision === baseline.revision) {
    if (
      current
      && pairMatches(current, event.session)
      && event.session.version > current.version
    ) return { kind: "reload", baseline };
    return { kind: "ignored", baseline };
  }
  if (event.revision !== baseline.revision + 1) {
    return { kind: "reload", baseline };
  }
  if (
    event.kind === "removed"
    || event.session.status === "discarded"
  ) return { kind: "reload", baseline };
  if (
    event.session.status === "completed"
    && !("completed_item" in event.session)
  ) return { kind: "reload", baseline };

  if (!current) {
    if (event.session.version === 1) return { kind: "reload", baseline };
    return {
      kind: "accepted",
      baseline: {
        ...baseline,
        revision: event.revision,
        lastAcceptedOrder: event.last_accepted_order,
        summary: event.summary,
        actionWatermark: event.action_watermark ?? baseline.actionWatermark
      }
    };
  }
  if (!pairMatches(current, event.session)) {
    return { kind: "reload", baseline };
  }
  if (event.session.version <= current.version) {
    return { kind: "reload", baseline };
  }
  if (event.session.version !== current.version + 1) {
    return { kind: "reload", baseline };
  }
  const next = replaceItem(baseline, index, event);
  return next
    ? { kind: "accepted", baseline: next }
    : { kind: "reload", baseline };
}
