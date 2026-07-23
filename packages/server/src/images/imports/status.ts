import { EventEmitter } from "node:events";
import { pool } from "../../core/db.ts";
import { ApiError } from "../../core/api-error.ts";
import type {
  ImportMode,
  ImportStatus,
  ImportStatusEvent
} from "./types.ts";

const activeImportPhases = new Map<
  string,
  { phase: string; message: string; progress?: number }
>();
const importStatusEvents = new EventEmitter();
importStatusEvents.setMaxListeners(0);

function canonicalImportId(id: string) {
  return id.toLowerCase();
}

function uniqueImportIds(ids: string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    const canonicalId = canonicalImportId(id);
    if (seen.has(canonicalId)) continue;
    seen.add(canonicalId);
    unique.push(id);
    if (unique.length === 100) break;
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
  if (status === "preparing") return "标准化图片并生成缩略图";
  if (status === "ready") return "服务端处理完成";
  if (status === "committing") return "写入图库";
  if (status === "finalized") return "已写入图库";
  if (status === "failed") return error || "处理失败";
  if (status === "cancelled") return "已取消";
  return "等待处理";
}

function emitImportStatus(status: ImportStatusEvent) {
  importStatusEvents.emit("status", status);
}

export function emitCancelledImportStatus(id: string) {
  emitImportStatus({
    id,
    status: "cancelled",
    error: "",
    phase: "cancelled",
    message: "已取消"
  });
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

async function getImportStatus(id: string) {
  const row = (await pool.query(
    "SELECT mode, status, error FROM import_session WHERE id=$1",
    [id]
  )).rows[0] as {
    mode: ImportMode;
    status: ImportStatus;
    error: string;
  } | undefined;
  if (!row) throw new ApiError(404, "not_found", "导入任务不存在");
  return presentImportStatus(id, row);
}

function presentImportStatus(
  id: string,
  row: {
    mode: ImportMode;
    status: ImportStatus;
    error: string;
  }
) {
  const phase = ["created", "materializing", "preparing"].includes(row.status)
    ? activeImportPhases.get(canonicalImportId(id))
    : undefined;
  return {
    status: row.status,
    error: row.error,
    phase: phase?.phase ?? row.status,
    message: phase?.message ?? importMessage(row.status, row.mode, row.error),
    progress: phase?.progress
  };
}

async function getImportStatusEvent(id: string): Promise<ImportStatusEvent> {
  return { id, ...await getImportStatus(id) };
}

function missingImportStatus(id: string): ImportStatusEvent {
  return {
    id,
    status: "missing",
    error: "导入任务不存在",
    phase: "missing",
    message: "导入任务不存在"
  };
}

export async function listImportStatuses(ids: string[]) {
  const uniqueIds = uniqueImportIds(ids);
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

export function streamImportEvents(ids: string[]): Response {
  const uniqueIds = uniqueImportIds(ids);
  const watched = new Map(
    uniqueIds.map((id) => [canonicalImportId(id), id])
  );
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let listener: ((status: ImportStatusEvent) => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeServerSentEvent(event, data)));
        } catch {
          closed = true;
        }
      };

      listener = (status) => {
        const responseId = watched.get(canonicalImportId(status.id));
        if (!responseId) return;
        send("import-status", responseId === status.id
          ? status
          : { ...status, id: responseId });
      };
      importStatusEvents.on("status", listener);
      send("ready", { ids: uniqueIds });

      void listImportStatuses(uniqueIds)
        .then((statuses) => {
          for (const status of statuses) send("import-status", status);
        })
        .catch(() => {
          for (const id of uniqueIds) {
            send("import-status", missingImportStatus(id));
          }
        });

      heartbeat = setInterval(() => {
        send("ping", { now: Date.now() });
      }, 15_000);
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (listener) importStatusEvents.off("status", listener);
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
