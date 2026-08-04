import type { Query, QueryState } from "@tanstack/react-query";
import type {
  ReadyImageCacheAdminStatusDto
} from "@imageshow/shared/browser";

const STATUS_POLL_INTERVAL_MS = 1_000;
const STATUS_POLL_MAX_BACKOFF_MS = 30_000;

type ReadyImageCachePollingState = Pick<
  QueryState<ReadyImageCacheAdminStatusDto, Error>,
  | "data"
  | "dataUpdateCount"
  | "dataUpdatedAt"
  | "errorUpdateCount"
  | "status"
>;

type ReadyImageCachePollingQuery = Pick<
  Query<
    ReadyImageCacheAdminStatusDto,
    Error,
    ReadyImageCacheAdminStatusDto,
    readonly unknown[]
  >,
  "state"
>;

type PollingTracker = {
  dataUpdateCount: number;
  errorUpdateCount: number;
  failureStreak: number;
};

const pollingTrackers = new WeakMap<object, PollingTracker>();

function pollingTracker(
  query: ReadyImageCachePollingQuery,
  state: ReadyImageCachePollingState
) {
  let tracker = pollingTrackers.get(query);
  if (
    !tracker
    || state.dataUpdateCount < tracker.dataUpdateCount
    || state.errorUpdateCount < tracker.errorUpdateCount
  ) {
    tracker = {
      dataUpdateCount: state.dataUpdateCount,
      errorUpdateCount: state.errorUpdateCount,
      failureStreak: state.status === "error" ? 1 : 0
    };
    pollingTrackers.set(query, tracker);
    return tracker;
  }

  if (state.dataUpdateCount > tracker.dataUpdateCount) {
    tracker.dataUpdateCount = state.dataUpdateCount;
    tracker.failureStreak = 0;
  }
  if (state.errorUpdateCount > tracker.errorUpdateCount) {
    const failures = state.errorUpdateCount - tracker.errorUpdateCount;
    tracker.errorUpdateCount = state.errorUpdateCount;
    if (state.status === "error") tracker.failureStreak += failures;
  }
  return tracker;
}

export function readyImageCacheRefetchInterval(
  query: ReadyImageCachePollingQuery,
  refreshAfter = 0
): number | false {
  const state = query.state;
  const tracker = pollingTracker(query, state);
  const needsNewerStatus = refreshAfter > 0
    && state.dataUpdatedAt <= refreshAfter;
  if (!state.data?.rebuilding && !needsNewerStatus) return false;
  if (state.status !== "error") return STATUS_POLL_INTERVAL_MS;
  const exponent = Math.min(
    Math.max(tracker.failureStreak - 1, 0),
    5
  );
  return Math.min(
    STATUS_POLL_INTERVAL_MS * (2 ** exponent),
    STATUS_POLL_MAX_BACKOFF_MS
  );
}
