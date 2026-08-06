import type { Query, QueryState } from "@tanstack/react-query";
import type {
  AdminCheckStatusDto
} from "@imageshow/shared/browser";

const STATUS_POLL_INTERVAL_MS = 1_000;
const STATUS_POLL_MAX_BACKOFF_MS = 30_000;

type ReadyImageCachePollingState = Pick<
  QueryState<AdminCheckStatusDto, Error>,
  | "data"
  | "dataUpdateCount"
  | "dataUpdatedAt"
  | "errorUpdateCount"
  | "status"
>;

type ReadyImageCachePollingQuery = Pick<
  Query<
    AdminCheckStatusDto,
    Error,
    AdminCheckStatusDto,
    readonly unknown[]
  >,
  "state"
>;

type PollingTracker = {
  dataUpdateCount: number;
  errorUpdateCount: number;
  failureStreak: number;
  rebuilding: boolean;
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
    const resourceFailed = redisResourceFailed(state.data);
    tracker = {
      dataUpdateCount: state.dataUpdateCount,
      errorUpdateCount: state.errorUpdateCount,
      failureStreak: state.status === "error" || resourceFailed ? 1 : 0,
      rebuilding: projectionIsRebuilding(state.data)
    };
    pollingTrackers.set(query, tracker);
    return tracker;
  }

  if (state.dataUpdateCount > tracker.dataUpdateCount) {
    const updates = state.dataUpdateCount - tracker.dataUpdateCount;
    tracker.dataUpdateCount = state.dataUpdateCount;
    if (redisResourceFailed(state.data)) {
      tracker.failureStreak += updates;
    } else {
      tracker.failureStreak = 0;
      tracker.rebuilding = projectionIsRebuilding(state.data);
    }
  }
  if (state.errorUpdateCount > tracker.errorUpdateCount) {
    const failures = state.errorUpdateCount - tracker.errorUpdateCount;
    tracker.errorUpdateCount = state.errorUpdateCount;
    if (state.status === "error") tracker.failureStreak += failures;
  }
  return tracker;
}

function projectionIsRebuilding(status: AdminCheckStatusDto | undefined) {
  return status?.redis.status === "ok"
    && status.redis.data.image_projection.rebuilding;
}

function redisResourceFailed(status: AdminCheckStatusDto | undefined) {
  return status?.redis.status === "error";
}

export function adminCheckStatusRefetchInterval(
  query: ReadyImageCachePollingQuery,
  refreshAfter = 0
): number | false {
  const state = query.state;
  const tracker = pollingTracker(query, state);
  const needsNewerStatus = refreshAfter > 0
    && state.dataUpdatedAt <= refreshAfter;
  if (!tracker.rebuilding && !needsNewerStatus) return false;
  if (state.status !== "error" && !redisResourceFailed(state.data)) {
    return STATUS_POLL_INTERVAL_MS;
  }
  const exponent = Math.min(
    Math.max(tracker.failureStreak - 1, 0),
    5
  );
  return Math.min(
    STATUS_POLL_INTERVAL_MS * (2 ** exponent),
    STATUS_POLL_MAX_BACKOFF_MS
  );
}
