import { useEffect, useMemo } from "react";
import type { RefObject } from "react";
import { adminApiBasePath } from "../../../lib/constants.js";
import type { ImportJob } from "../../../lib/types.js";
import { getStoredImportStatuses, storedImportStatusMessage, type StoredImportStatus } from "./import-api.js";

const STATUS_POLL_INTERVAL_MS = 2_000;
const SSE_CONNECT_TIMEOUT_MS = 5_000;
const terminalStatuses = new Set<ImportJob["status"]>([
  "ready",
  "cancelling",
  "done",
  "failed",
  "cancelled"
]);

function patchFromStatus(job: ImportJob, state: StoredImportStatus): Partial<ImportJob> | null {
  const message = storedImportStatusMessage(state);
  if (["materialize-waiting", "prepare-waiting"].includes(state.phase)) {
    return { status: "queued", message };
  }
  if (state.status === "created") return { status: "queued", message };
  if (state.status === "materializing") {
    if (job.kind === "local") return { status: "uploading", message };
    return { status: "downloading", message, transferProgress: state.progress };
  }
  if (state.status === "received") {
    return { status: "processing", message, transferProgress: undefined };
  }
  if (state.status === "preparing") return { status: "processing", message, transferProgress: undefined };
  if (state.status === "ready") return { status: "processing", message, transferProgress: undefined };
  if (state.status === "committing") return { status: "committing", message };
  if (state.status === "finalized") return { status: "done", message };
  if (state.status === "missing") return null;
  if (state.status === "failed") return { status: "failed", failureStage: "prepare", message };
  if (state.status === "cancelled") return { status: "cancelled", message };
  return null;
}

function applyStoredImportStatus(
  state: StoredImportStatus,
  jobsRef: RefObject<ImportJob[]>,
  updateJob: (id: string, patch: Partial<ImportJob>) => void
) {
  const job = jobsRef.current.find((item) => item.sessionId === state.id);
  if (!job || terminalStatuses.has(job.status)) return;
  const patch = patchFromStatus(job, state);
  if (patch) updateJob(job.id, patch);
}

export function useImportStatusEvents(
  jobs: ImportJob[],
  jobsRef: RefObject<ImportJob[]>,
  updateJob: (id: string, patch: Partial<ImportJob>) => void
) {
  const idsKey = useMemo(() => {
    return jobs
      .filter((job) => job.sessionId && !terminalStatuses.has(job.status))
      .map((job) => job.sessionId!)
      .sort()
      .join(",");
  }, [jobs]);

  useEffect(() => {
    if (!idsKey) return;
    let stopped = false;
    let polling = false;
    let source: EventSource | undefined;
    let connectTimeout: ReturnType<typeof setTimeout> | undefined;
    let pollTimeout: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const ids = idsKey.split(",").filter(Boolean);

    const clearConnectTimeout = () => {
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = undefined;
      }
    };

    const poll = async () => {
      controller = new AbortController();
      try {
        const states = await getStoredImportStatuses(ids, controller.signal);
        if (!stopped) states.forEach((state) => applyStoredImportStatus(state, jobsRef, updateJob));
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
      } finally {
        if (!stopped && polling) pollTimeout = setTimeout(poll, STATUS_POLL_INTERVAL_MS);
      }
    };

    const startPolling = () => {
      if (stopped || polling) return;
      polling = true;
      clearConnectTimeout();
      source?.close();
      pollTimeout = setTimeout(poll, STATUS_POLL_INTERVAL_MS);
    };

    source = new EventSource(`${adminApiBasePath}/imports/events?ids=${encodeURIComponent(idsKey)}`);
    connectTimeout = setTimeout(startPolling, SSE_CONNECT_TIMEOUT_MS);
    source.addEventListener("ready", clearConnectTimeout);
    source.addEventListener("import-status", (event) => {
      clearConnectTimeout();
      const state = JSON.parse((event as MessageEvent<string>).data) as StoredImportStatus;
      applyStoredImportStatus(state, jobsRef, updateJob);
    });
    source.addEventListener("error", startPolling);

    return () => {
      stopped = true;
      clearConnectTimeout();
      source?.close();
      if (pollTimeout) clearTimeout(pollTimeout);
      controller?.abort();
    };
  }, [idsKey, jobsRef, updateJob]);
}
