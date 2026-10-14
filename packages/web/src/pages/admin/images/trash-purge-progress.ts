import {
  trashPurgeEventsPath,
  type TrashPurgeProgressDto
} from "@imageshow/shared/browser";

export type TrashPurgeProgressStream = {
  /** The first state without pending work, or null when the stream stopped first. */
  done: Promise<TrashPurgeProgressDto | null>;
  close: () => void;
};

/**
 * Follow the server-pushed purge state. Open it only after the intent of
 * interest has committed: its first state is then read after that commit.
 * The browser reconnects a dropped stream and receives the current state.
 */
export function openTrashPurgeProgress(
  onProgress: (progress: TrashPurgeProgressDto) => void
): TrashPurgeProgressStream {
  const { promise, resolve } = Promise.withResolvers<TrashPurgeProgressDto | null>();
  const source = new EventSource(trashPurgeEventsPath);
  const finish = (progress: TrashPurgeProgressDto | null) => {
    source.close();
    resolve(progress);
  };
  source.addEventListener("progress", (event) => {
    let progress: TrashPurgeProgressDto;
    try {
      progress = JSON.parse((event as MessageEvent<string>).data) as TrashPurgeProgressDto;
    } catch {
      finish(null);
      return;
    }
    onProgress(progress);
    if (!progress.pending) finish(progress);
  });
  source.addEventListener("error", () => {
    // Rejected connections (expired session, missing permission) stay closed.
    if (source.readyState === EventSource.CLOSED) finish(null);
  });
  return { done: promise, close: () => finish(null) };
}
