import type { ImportStatusSubscriptionInputDto } from "@imageshow/shared/browser";
import type { RefObject } from "react";
import { fetchApi } from "../../../lib/api/client.js";
import { adminApiBasePath } from "../../../lib/constants.js";
import type { ImportJob } from "../../../lib/types.js";
import { getStoredImportStatuses, type StoredImportStatus } from "./import-api.js";
import {
  activeImportSessionIds,
  importJobAcceptsStatus,
  type ImportStatusSubscriptionSpec
} from "./import-status-subscription.js";
import { importStatusEventPatch } from "./import-status-state.js";

const STATUS_POLL_INTERVAL_MS = 2_000;
const SSE_CONNECT_TIMEOUT_MS = 5_000;
const SSE_MAX_BUFFER_BYTES = 128 * 1024;

function applyStoredImportStatus(
  state: StoredImportStatus,
  jobsRef: RefObject<ImportJob[]>,
  updateJob: (id: string, patch: Partial<ImportJob>) => void
) {
  const stateId = state.id.toLowerCase();
  const job = jobsRef.current.find(
    (item) => item.sessionId?.toLowerCase() === stateId
  );
  if (!job || !importJobAcceptsStatus(job)) return;
  const patch = importStatusEventPatch(job, state);
  if (patch) updateJob(job.id, patch);
}

function nextServerSentEvent(buffer: string) {
  const boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  if (!boundary || boundary.index === undefined) return undefined;
  return {
    block: buffer.slice(0, boundary.index),
    rest: buffer.slice(boundary.index + boundary[0].length)
  };
}

function parseServerSentEvent(block: string) {
  const fields = block.split(/\r\n|\r|\n/);
  return {
    event: fields.find((line) => line.startsWith("event:"))
      ?.slice("event:".length).trim(),
    data: fields
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
  };
}

export function startImportStatusSubscription(
  spec: ImportStatusSubscriptionSpec,
  jobsRef: RefObject<ImportJob[]>,
  updateJob: (id: string, patch: Partial<ImportJob>) => void
) {
  let stopped = false;
  let polling = false;
  const streamController = new AbortController();
  let streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let connectTimeout: ReturnType<typeof setTimeout> | undefined;
  let pollTimeout: ReturnType<typeof setTimeout> | undefined;
  let pollController: AbortController | undefined;
  const jobIds = new Set(spec.jobIds);

  const clearConnectTimeout = () => {
    if (connectTimeout) {
      clearTimeout(connectTimeout);
      connectTimeout = undefined;
    }
  };

  const currentJobs = () => jobsRef.current.filter(
    (job) => jobIds.has(job.id)
  );

  const poll = async () => {
    pollController = new AbortController();
    try {
      const ids = activeImportSessionIds(currentJobs());
      if (ids.length) {
        const states = await getStoredImportStatuses(ids, pollController.signal);
        if (!stopped) {
          states.forEach((state) => (
            applyStoredImportStatus(state, jobsRef, updateJob)
          ));
        }
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
    } finally {
      if (
        !stopped
        && polling
        && currentJobs().some(importJobAcceptsStatus)
      ) {
        pollTimeout = setTimeout(poll, STATUS_POLL_INTERVAL_MS);
      }
    }
  };

  const startPolling = () => {
    if (stopped || polling) return;
    polling = true;
    clearConnectTimeout();
    streamController.abort();
    void streamReader?.cancel().catch(() => undefined);
    pollTimeout = setTimeout(poll, STATUS_POLL_INTERVAL_MS);
  };

  connectTimeout = setTimeout(startPolling, SSE_CONNECT_TIMEOUT_MS);
  const input: ImportStatusSubscriptionInputDto = {
    attempt_keys: [...spec.attemptKeys]
  };
  void fetchApi(`${adminApiBasePath}/imports/events`, {
    method: "POST",
    headers: { Accept: "text/event-stream" },
    body: JSON.stringify(input),
    signal: streamController.signal
  }).then(async (response) => {
    if (
      !response.ok
      || !response.body
      || !response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Import status stream failed with HTTP ${response.status}`);
    }
    if (stopped) {
      await response.body.cancel().catch(() => undefined);
      return;
    }
    streamReader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await streamReader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let framed = nextServerSentEvent(buffer);
      while (framed) {
        if (framed.block.length > SSE_MAX_BUFFER_BYTES) {
          throw new Error("Import status stream event is too large");
        }
        buffer = framed.rest;
        const { event, data } = parseServerSentEvent(framed.block);
        if (event === "ready") {
          clearConnectTimeout();
        } else if (event === "import-status") {
          clearConnectTimeout();
          applyStoredImportStatus(
            JSON.parse(data) as StoredImportStatus,
            jobsRef,
            updateJob
          );
        }
        framed = nextServerSentEvent(buffer);
      }
      if (buffer.length > SSE_MAX_BUFFER_BYTES) {
        throw new Error("Import status stream event is too large");
      }
    }
    if (!stopped) startPolling();
  }).catch(() => {
    if (!stopped && !polling) startPolling();
  });

  return () => {
    stopped = true;
    clearConnectTimeout();
    streamController.abort();
    void streamReader?.cancel().catch(() => undefined);
    if (pollTimeout) clearTimeout(pollTimeout);
    pollController?.abort();
  };
}
