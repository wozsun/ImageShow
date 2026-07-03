import { useEffect, useMemo } from "react";
import type { RefObject } from "react";
import { adminApiBasePath } from "../../../lib/constants.js";
import type { ImportJob } from "../../../lib/types.js";
import { getStoredImportStatuses, storedImportStatusMessage, type StoredImportStatus } from "./import-api.js";

const STATUS_POLL_INTERVAL_MS = 2_000;
const terminalStatuses = new Set<ImportJob["status"]>(["ready", "done", "failed", "cancelled"]);

function patchFromStatus(job: ImportJob, state: StoredImportStatus): Partial<ImportJob> | null {
  const message = storedImportStatusMessage(state);
  if (state.status === "created") return { status: "queued", message };
  if (state.status === "receiving") return { status: job.kind === "download" ? "downloading" : "uploading", message };
  if (state.status === "preparing") return { status: "processing", message };
  if (state.status === "ready") return { status: "processing", message };
  if (state.status === "committing") return { status: "committing", message };
  if (state.status === "finalized") return { status: "done", message };
  if (state.status === "failed" || state.status === "missing") return { status: "failed", failureStage: "prepare", message };
  if (state.status === "cancelled") return { status: "cancelled", message };
  return null;
}

function applyStoredImportStatus(
  state: StoredImportStatus,
  jobsRef: RefObject<ImportJob[]>,
  updateJob: (id: string, patch: Partial<ImportJob>) => void
) {
  if (!state.id) return;
  const job = jobsRef.current.find((item) => item.stagingId === state.id || item.id === state.id);
  if (!job || job.kind === "proxy" || terminalStatuses.has(job.status)) return;
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
      .filter((job) => job.kind !== "proxy" && job.stagingId && !terminalStatuses.has(job.status))
      .map((job) => job.stagingId!)
      .sort()
      .join(",");
  }, [jobs]);

  useEffect(() => {
    if (!idsKey) return;
    const source = new EventSource(`${adminApiBasePath}/imports/events?ids=${encodeURIComponent(idsKey)}`);
    source.addEventListener("import-status", (event) => {
      const state = JSON.parse((event as MessageEvent<string>).data) as StoredImportStatus;
      applyStoredImportStatus(state, jobsRef, updateJob);
    });
    return () => source.close();
  }, [idsKey, jobsRef, updateJob]);

  useEffect(() => {
    if (!idsKey) return;
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const ids = idsKey.split(",").filter(Boolean);

    const poll = async () => {
      controller = new AbortController();
      try {
        const states = await getStoredImportStatuses(ids, controller.signal);
        if (!stopped) states.forEach((state) => applyStoredImportStatus(state, jobsRef, updateJob));
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          // 轮询只是 SSE 兜底，单次失败不打断后续状态刷新。
        }
      } finally {
        if (!stopped) timeout = setTimeout(poll, STATUS_POLL_INTERVAL_MS);
      }
    };

    timeout = setTimeout(poll, STATUS_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      if (timeout) clearTimeout(timeout);
      controller?.abort();
    };
  }, [idsKey, jobsRef, updateJob]);
}
