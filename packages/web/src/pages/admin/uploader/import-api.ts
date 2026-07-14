import { api, getCsrfToken } from "../../../lib/api/client.js";
import { adminApiBasePath } from "../../../lib/constants.js";
import type { Brightness, Device, ImageDraft, ImageItem } from "../../../lib/types.js";

export type PreparedImport = {
  id: string;
  mode: "upload" | "download" | "proxy";
  preview_url: string;
  preview_full_url: string;
  width: number;
  height: number;
  original_width: number;
  original_height: number;
  ext: string;
  md5: string;
  original_size: number;
  size: number;
  quality: number | null;
  transcoded: boolean;
  device: Device;
  brightness: Brightness;
  storage_slug: string;
  duplicate_exists: boolean;
  duplicates: ImageItem[];
};

export type ImportSession = {
  id: string;
  mode: "upload" | "download" | "proxy";
  status: string;
  upload_url?: string;
  prepare_url: string;
  preview_url: string;
  preview_full_url?: string;
  expires_at: string;
};

export type ImportSessionHandle = Pick<ImportSession, "id" | "mode" | "status" | "prepare_url"> & {
  upload_url?: string;
};

export type ImportSessionCreateInput = ImageDraft & {
  mode: "upload" | "download" | "proxy";
  size?: number;
  source_url?: string;
  image_time?: string;
  batch_time?: string;
  manifest_position?: number;
  idempotency_key: string;
  storage_slug: string;
};

export type BatchImportSessionResult =
  | { idempotency_key: string; session: ImportSessionHandle }
  | { idempotency_key: string; error: string; code: string };

export type JsonlManifestItem = {
  line: number;
  manifest_position: number;
  original: string;
  source?: string;
  image_time?: string;
  mode?: "download" | "proxy";
  author?: string;
  tags?: string[];
  title?: string;
  description?: string;
  theme?: string;
  device?: Device | "auto";
  brightness?: Brightness | "auto";
  storage_slug?: string;
};

export type JsonlManifestParseError = {
  line: number;
  raw: string;
  error: string;
};

export type JsonlManifestResult = {
  items: JsonlManifestItem[];
  errors: JsonlManifestParseError[];
  total: number;
};

export type StoredImportStatus = {
  id?: string;
  status: string;
  error: string;
  phase?: string;
  message?: string;
};

type ImportFileReceiveResult = {
  id: string;
  status: string;
};

export function getStoredImportStatuses(ids: string[], signal?: AbortSignal) {
  const query = encodeURIComponent(ids.join(","));
  return api<{ items: StoredImportStatus[] }>(`${adminApiBasePath}/imports/status?ids=${query}`, { signal }).then((result) => result.items);
}

export function createImportSession(input: ImportSessionCreateInput, signal?: AbortSignal) {
  return api<ImportSession>(`${adminApiBasePath}/imports/create`, { method: "POST", body: JSON.stringify(input), signal });
}

export function createImportSessionsBatch(
  source: "urls" | "jsonl",
  items: ImportSessionCreateInput[],
  signal?: AbortSignal
) {
  type RawResult =
    | { idempotency_key: string; id: string; mode: "download" | "proxy"; status: string }
    | { idempotency_key: string; error: string; code: string };
  return api<{ items: RawResult[] }>(`${adminApiBasePath}/imports/batch-create`, {
    method: "POST",
    body: JSON.stringify({ source, items }),
    signal
  }).then(({ items: results }): BatchImportSessionResult[] => results.map((result) => {
    if ("error" in result) return result;
    return {
      idempotency_key: result.idempotency_key,
      session: {
        id: result.id,
        mode: result.mode,
        status: result.status,
        prepare_url: `${adminApiBasePath}/imports/${result.id}/prepare`
      }
    };
  }));
}

export function parseImportJsonl(content: string, signal?: AbortSignal) {
  return api<JsonlManifestResult>(`${adminApiBasePath}/imports/jsonl/parse`, {
    method: "POST",
    body: JSON.stringify({ content }),
    signal
  });
}

export function prepareImportSession(session: ImportSessionHandle, signal?: AbortSignal) {
  return api<PreparedImport>(session.prepare_url, { method: "POST", signal });
}

export function storedImportStatusMessage(state: StoredImportStatus) {
  if (state.status === "failed") return state.error || "处理失败";
  if (state.message) return state.message;
  if (state.status === "created") return "等待接收原图";
  if (state.status === "receiving") return "服务端接收原图";
  if (state.status === "preparing") return "标准化图片并生成缩略图";
  if (state.status === "ready") return "服务端处理完成";
  if (state.status === "committing") return "写入图库";
  if (state.status === "finalized") return "已写入图库";
  if (state.status === "cancelled") return "已取消";
  return "等待处理";
}

export function uploadLocalRaw(
  session: ImportSessionHandle,
  file: File,
  callbacks: { onProgress: (progress: number) => void; onUploaded: () => void }
) {
  if (!session.upload_url) throw new Error("上传会话缺少 upload URL");
  const request = new XMLHttpRequest();
  const promise = new Promise<ImportFileReceiveResult>((resolve, reject) => {
    request.open("PUT", session.upload_url!);
    const csrf = getCsrfToken();
    if (csrf) request.setRequestHeader("x-csrf-token", csrf);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) callbacks.onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };
    request.upload.onload = callbacks.onUploaded;
    request.onload = () => {
      const data = parseUploadResponse(request.responseText);
      if (request.status >= 200 && request.status < 300 && data.ok !== false) {
        resolve(data as ImportFileReceiveResult);
        return;
      }
      reject(new Error(String(data.error || `上传失败（HTTP ${request.status}）`)));
    };
    request.onerror = () => reject(new Error("上传网络请求失败"));
    request.onabort = () => reject(new Error("上传已取消"));
    request.send(file);
  });
  return { promise, abort: () => request.abort() };
}

function parseUploadResponse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function cancelStoredImport(sessionId: string) {
  return api(`${adminApiBasePath}/imports/${sessionId}/cancel`, { method: "POST" });
}

export function commitStoredImport(sessionId: string, draft: ImageDraft) {
  return api<{ status: "imported" | "duplicate"; item?: ImageItem }>(`${adminApiBasePath}/imports/${sessionId}/commit`, {
    method: "POST",
    body: JSON.stringify(draft)
  });
}
