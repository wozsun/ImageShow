import { EventEmitter } from "node:events";
import { appConfig } from "@imageshow/shared";
import { pool } from "../../core/db.ts";
import { ApiError, errorMessage } from "../../core/http.ts";
import { redis } from "../../core/redis-client.ts";
import type { ImportMode, ImportStatus, ImportStatusEvent } from "./types.ts";

const activeImportPhases = new Map<string, { phase: string; message: string }>();
const importStatusEvents = new EventEmitter();
const cancelledImports = new Map<string, number>();
const importLeaseHeartbeatMs = Math.max(
  1_000,
  Math.min(30_000, Math.floor(appConfig.uploadTtlSeconds * 1_000 / 3))
);

importStatusEvents.setMaxListeners(0);

function cancelledImportKey(id: string) {
  return `imageshow:import-cancelled:${id}`;
}

async function renewImportLease(id: string, required = false) {
  const renewed = await pool.query(
    `UPDATE import_session
     SET expires_at=now() + ($2 * interval '1 second')
     WHERE id=$1 AND status IN ('created','receiving','preparing','ready','committing')`,
    [id, appConfig.uploadTtlSeconds]
  );
  if (required && !renewed.rowCount) {
    throw new ApiError(409, "invalid_import_state", "导入任务已结束或不存在");
  }
}

export async function withImportLease<T>(id: string, work: () => Promise<T>): Promise<T> {
  await renewImportLease(id, true);
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal.then(() => renewImportLease(id)).catch(() => undefined);
  }, importLeaseHeartbeatMs);
  timer.unref();
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await renewal;
  }
}

function importMessage(status: string, mode?: string, error?: string) {
  if (status === "created") return mode === "upload" ? "等待接收原图" : "等待开始处理";
  if (status === "receiving") return mode === "download" ? "服务端下载原图" : "服务端接收上传文件";
  if (status === "preparing") return mode === "proxy" ? "探测外链并生成缩略图" : "标准化图片并生成缩略图";
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
  emitImportStatus({ id, status: "cancelled", error: "", phase: "cancelled", message: "已取消" });
}

export async function notifyImportStatus(id: string) {
  emitImportStatus(await getImportStatusEvent(id));
}

export function setImportPhase(id: string, phase: string, message: string) {
  activeImportPhases.set(id, { phase, message });
  notifyImportStatus(id).catch(() => undefined);
}

export function clearImportPhase(id: string) {
  activeImportPhases.delete(id);
}

export async function importWasCancelled(id: string) {
  const expires = cancelledImports.get(id) ?? 0;
  if (expires > Date.now()) return true;
  if (expires) cancelledImports.delete(id);
  return Boolean(await redis.get(cancelledImportKey(id)).catch(() => null));
}

export async function markImportCancelled(id: string) {
  cancelledImports.set(id, Date.now() + appConfig.uploadTtlSeconds * 1000);
  await redis.set(cancelledImportKey(id), "1", "EX", appConfig.uploadTtlSeconds).catch(() => undefined);
}

export async function assertImportStillPreparing(id: string) {
  const row = (await pool.query("SELECT status FROM import_session WHERE id=$1", [id])).rows[0] as {
    status?: ImportStatus;
  } | undefined;
  if (!row || row.status === "cancelled") throw new ApiError(409, "import_cancelled", "导入已取消");
  if (row.status !== "preparing") {
    throw new ApiError(409, "invalid_import_state", "导入任务状态已变化");
  }
}

export async function markImportFailed(id: string, error: unknown) {
  const failed = await pool.query(
    "UPDATE import_session SET status='failed', error=$2, updated_at=now() WHERE id=$1 AND status IN ('receiving','preparing')",
    [id, errorMessage(error)]
  ).catch(() => undefined);
  if (failed && "rowCount" in failed && failed.rowCount) {
    await notifyImportStatus(id).catch(() => undefined);
  }
}

async function getImportStatus(id: string) {
  const row = (await pool.query(
    "SELECT mode, status, error FROM import_session WHERE id=$1",
    [id]
  )).rows[0] as { mode: ImportMode; status: ImportStatus; error: string } | undefined;
  if (!row) throw new ApiError(404, "not_found", "导入任务不存在");
  const phase = ["created", "receiving", "preparing"].includes(row.status)
    ? activeImportPhases.get(id)
    : undefined;
  return {
    status: row.status,
    error: row.error,
    phase: phase?.phase ?? row.status,
    message: phase?.message ?? importMessage(row.status, row.mode, row.error)
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

export async function listImportStatuses(ids: string[]): Promise<ImportStatusEvent[]> {
  const uniqueIds = [...new Set(ids)].slice(0, 100);
  return Promise.all(uniqueIds.map(async (id) => {
    try {
      return await getImportStatusEvent(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return missingImportStatus(id);
      throw error;
    }
  }));
}

function encodeServerSentEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function streamImportEvents(ids: string[]): Response {
  const uniqueIds = [...new Set(ids)].slice(0, 100);
  const watched = new Set(uniqueIds);
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
        if (watched.has(status.id)) send("import-status", status);
      };
      importStatusEvents.on("status", listener);
      send("ready", { ids: uniqueIds });

      for (const id of uniqueIds) {
        getImportStatusEvent(id)
          .then((status) => send("import-status", status))
          .catch(() => send("import-status", missingImportStatus(id)));
      }

      heartbeat = setInterval(() => send("ping", { now: Date.now() }), 15_000);
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
