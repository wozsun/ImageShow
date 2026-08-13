import { EventEmitter } from "node:events";
import { pool } from "../../core/database-pools.ts";
import { ApiError } from "../../core/api-error.ts";
import {
  importStatusBatchMaxItems,
  type ImportMode,
  type ImportStatus,
  type StoredImportStatusDto
} from "@imageshow/shared/browser";
import {
  canonicalImportSubscriptionKey,
  ImportStatusSubscription
} from "./status-subscription.ts";

const activeImportPhases = new Map<
  string,
  { phase: string; message: string; progress?: number }
>();
const importStatusEvents = new EventEmitter();
importStatusEvents.setMaxListeners(0);

type ImportStatusEvent = StoredImportStatusDto & {
  attemptKey?: string;
};

const importPhaseStatuses = new Map<string, ImportStatus>([
  ["materialize-waiting", "created"],
  ["uploading", "materializing"],
  ["downloading", "materializing"],
  ["prepare-waiting", "received"],
  ["normalizing", "preparing"],
  ["detecting", "preparing"],
  ["staging", "preparing"]
]);

function canonicalImportId(id: string) {
  return canonicalImportSubscriptionKey(id);
}

function uniqueImportKeys(ids: string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    const canonicalId = canonicalImportId(id);
    if (seen.has(canonicalId)) continue;
    seen.add(canonicalId);
    unique.push(id);
    if (unique.length === importStatusBatchMaxItems) break;
  }
  return unique;
}

function importMessage(status: string, mode?: string, error?: string) {
  if (status === "created") {
    return mode === "upload"
      ? "等待浏览器上传原图"
      : "等待服务器下载原图";
  }
  if (status === "materializing") {
    return mode === "download" ? "服务端下载原图" : "服务端接收上传文件";
  }
  if (status === "received") return "原图素材已接收，等待处理";
  if (status === "preparing") return "准备标准化图片并生成缩略图";
  if (status === "ready") return "服务端处理完成";
  if (status === "committing") return "写入图库中";
  if (status === "finalized") return "已写入图库";
  if (status === "failed") return error || "处理失败";
  if (status === "cancelled") return "已取消";
  return "等待处理";
}

function emitImportStatus(status: ImportStatusEvent) {
  importStatusEvents.emit("status", status);
}

export async function notifyImportStatus(id: string) {
  emitImportStatus(await getImportStatusEvent(id));
}

export function setImportPhase(
  id: string,
  phase: string,
  message: string,
  progress?: number
) {
  activeImportPhases.set(canonicalImportId(id), { phase, message, progress });
  notifyImportStatus(id).catch(() => undefined);
}

export function setImportDownloadProgress(id: string, progress: number) {
  if (!Number.isFinite(progress)) return;
  const canonicalId = canonicalImportId(id);
  const activePhase = activeImportPhases.get(canonicalId);
  if (activePhase?.phase !== "downloading") return;
  const normalizedProgress = Math.min(100, Math.max(0, Math.round(progress)));
  if (activePhase.progress === normalizedProgress) return;
  const nextPhase = { ...activePhase, progress: normalizedProgress };
  activeImportPhases.set(canonicalId, nextPhase);
  emitImportStatus({
    id,
    status: "materializing",
    error: "",
    phase: nextPhase.phase,
    message: nextPhase.message,
    progress: normalizedProgress
  });
}

export function clearImportPhase(id: string) {
  activeImportPhases.delete(canonicalImportId(id));
}

async function getImportStatusEvent(id: string): Promise<ImportStatusEvent> {
  const row = (await pool.query(
    `SELECT mode, status, error, idempotency_key
       FROM import_session
      WHERE id=$1`,
    [id]
  )).rows[0] as {
    mode: ImportMode;
    status: ImportStatus;
    error: string;
    idempotency_key: string;
  } | undefined;
  if (!row) throw new ApiError(404, "not_found", "导入任务不存在");
  return {
    id,
    ...presentImportStatus(id, row),
    attemptKey: row.idempotency_key
  };
}

function presentImportStatus(
  id: string,
  row: {
    mode: ImportMode;
    status: ImportStatus;
    error: string;
  }
) {
  const activePhase = activeImportPhases.get(canonicalImportId(id));
  const phase = activePhase
    && importPhaseStatuses.get(activePhase.phase) === row.status
    ? activePhase
    : undefined;
  return {
    status: row.status,
    error: row.error,
    phase: phase?.phase ?? row.status,
    message: phase?.message ?? importMessage(row.status, row.mode, row.error),
    progress: phase?.progress
  };
}

function missingImportStatus(id: string): StoredImportStatusDto {
  return {
    id,
    status: "missing",
    error: "导入任务不存在",
    phase: "missing",
    message: "导入任务不存在"
  };
}

async function listImportStatusesByAttemptKeys(attemptKeys: string[]) {
  const uniqueAttemptKeys = uniqueImportKeys(attemptKeys);
  if (!uniqueAttemptKeys.length) return [];
  const rows = (await pool.query(
    `SELECT id, mode, status, error, idempotency_key
       FROM import_session
      WHERE idempotency_key = ANY($1::text[])`,
    [uniqueAttemptKeys]
  )).rows as Array<{
    id: string;
    mode: ImportMode;
    status: ImportStatus;
    error: string;
    idempotency_key: string;
  }>;
  const rowsByAttemptKey = new Map(
    rows.map((row) => [canonicalImportId(row.idempotency_key), row])
  );
  return uniqueAttemptKeys.flatMap((attemptKey) => {
    const row = rowsByAttemptKey.get(canonicalImportId(attemptKey));
    return row
      ? [{
          id: row.id,
          ...presentImportStatus(row.id, row),
          attemptKey
        } satisfies ImportStatusEvent]
      : [];
  });
}

export async function listImportStatuses(ids: string[]) {
  const uniqueIds = uniqueImportKeys(ids);
  if (!uniqueIds.length) return [];
  const rows = (await pool.query(
    `SELECT id, mode, status, error
       FROM import_session
      WHERE id = ANY($1::uuid[])`,
    [uniqueIds]
  )).rows as Array<{
    id: string;
    mode: ImportMode;
    status: ImportStatus;
    error: string;
  }>;
  // PostgreSQL serializes uuid values in lowercase while the UUID parser also
  // accepts uppercase input. Keep the caller's ID in the response, but use a
  // canonical lookup key so a valid uppercase ID is not reported as missing.
  const rowsById = new Map(
    rows.map((row) => [canonicalImportId(row.id), row])
  );
  return uniqueIds.map((id) => {
    const row = rowsById.get(canonicalImportId(id));
    return row
      ? { id, ...presentImportStatus(id, row) }
      : missingImportStatus(id);
  });
}

function encodeServerSentEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function streamImportEvents(
  attemptKeys: string[],
  requestSignal: AbortSignal
): Response {
  const uniqueAttemptKeys = uniqueImportKeys(attemptKeys);
  const subscription = new ImportStatusSubscription(uniqueAttemptKeys);
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cleaned = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let listener: ((status: ImportStatusEvent) => void) | undefined;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    requestSignal.removeEventListener("abort", closeStream);
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (listener) {
      importStatusEvents.off("status", listener);
      listener = undefined;
    }
  }

  function closeStream() {
    if (cleaned) return;
    cleanup();
    try {
      controller?.close();
    } catch {
      // The consumer may have cancelled the stream at the same time.
    }
  }

  function failStream(error: unknown) {
    if (cleaned) return;
    cleanup();
    try {
      controller?.error(error);
    } catch {
      // The stream may already be closed or errored.
    }
  }

  function send(event: string, data: unknown) {
    if (cleaned || !controller) return false;
    try {
      controller.enqueue(encoder.encode(encodeServerSentEvent(event, data)));
      return true;
    } catch (error) {
      failStream(error);
      return false;
    }
  }

  function sendImportStatus(status: ImportStatusEvent) {
    const responseId = subscription.observe(status);
    if (!responseId) return true;
    const { attemptKey: _attemptKey, ...publicStatus } = status;
    return send("import-status", responseId === publicStatus.id
      ? publicStatus
      : { ...publicStatus, id: responseId });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      if (requestSignal.aborted) {
        closeStream();
        return;
      }
      requestSignal.addEventListener("abort", closeStream, { once: true });

      listener = sendImportStatus;
      importStatusEvents.on("status", listener);
      if (!send("ready", { count: uniqueAttemptKeys.length })) return;

      void listImportStatusesByAttemptKeys(uniqueAttemptKeys)
        .then((statuses) => {
          if (cleaned) return;
          for (const status of statuses) {
            if (!sendImportStatus(status)) return;
          }
        })
        .catch(failStream);

      heartbeat = setInterval(() => {
        send("ping", { now: Date.now() });
      }, 15_000);
    },
    cancel() {
      cleanup();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
