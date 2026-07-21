import { api, getCsrfToken } from "../../../lib/api/client.js";
import { adminApiBasePath } from "../../../lib/constants.js";
import type { Brightness, Device, ImageDraft, ImageItem } from "../../../lib/types.js";

export type PreparedImport = {
  id: string;
  preview_url: string;
  preview_full_url: string;
  width: number;
  height: number;
  original_width: number;
  original_height: number;
  md5: string;
  original_size: number;
  size: number;
  quality: number | null;
  transcoded: boolean;
  detected_device: Device;
  detected_brightness: Brightness;
  storage_slug: string;
  duplicates: ImageItem[];
};

export type ImportSessionHandle = {
  id: string;
  upload_url?: string;
  materialize_url?: string;
  prepare_url: string;
};

export type ImportSessionCreateInput = ImageDraft & {
  mode: "upload" | "download";
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
  | { idempotency_key: string; error: string };

export type JsonlManifestItem = {
  line: number;
  manifest_position: number;
  original: string;
  source?: string;
  image_time?: string;
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
};

type WeiboImportPost = {
  source_url: string;
  weibo_id: string;
  bid: string;
  user_id: string;
  author: string | null;
  published_at: string;
  image_count: number;
};

export type WeiboImportParseError = {
  line: number;
  url: string;
  code: string;
  error: string;
};

export type WeiboImportResult = {
  posts: WeiboImportPost[];
  errors: WeiboImportParseError[];
  manifest: JsonlManifestResult;
};

type StoredImportServerStatus =
  | "created"
  | "materializing"
  | "received"
  | "preparing"
  | "ready"
  | "committing"
  | "finalized"
  | "failed"
  | "cancelled"
  | "missing";

export type StoredImportStatus = {
  id: string;
  status: StoredImportServerStatus;
  error: string;
  phase: string;
  message: string;
  progress?: number;
};

export type StoredImportCommitResult = {
  status: "imported" | "duplicate";
  item?: { object_url: string; thumb_url: string };
};

export function getStoredImportStatuses(ids: string[], signal?: AbortSignal) {
  const query = encodeURIComponent(ids.join(","));
  return api<{ items: StoredImportStatus[] }>(`${adminApiBasePath}/imports/status?ids=${query}`, { signal }).then((result) => result.items);
}

export async function getStoredImportStatus(id: string, signal?: AbortSignal) {
  const states = await getStoredImportStatuses([id], signal);
  return states[0];
}

export function createImportSession(input: ImportSessionCreateInput, signal?: AbortSignal) {
  return api<ImportSessionHandle>(`${adminApiBasePath}/imports/create`, { method: "POST", body: JSON.stringify(input), signal });
}

export function createImportSessionsBatch(
  source: "urls" | "jsonl" | "weibo",
  items: ImportSessionCreateInput[],
  signal?: AbortSignal
) {
  type RawResult =
    | { idempotency_key: string; id: string }
    | { idempotency_key: string; error: string };
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
        materialize_url: `${adminApiBasePath}/imports/${result.id}/materialize`,
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

export function parseWeiboImport(urls: string[], signal?: AbortSignal) {
  return api<WeiboImportResult>(`${adminApiBasePath}/imports/weibo/parse`, {
    method: "POST",
    body: JSON.stringify({ urls }),
    signal
  });
}

export function prepareImportSession(session: ImportSessionHandle, signal?: AbortSignal) {
  return api<PreparedImport>(session.prepare_url, { method: "POST", signal });
}

export async function materializeImportSession(
  session: ImportSessionHandle,
  signal?: AbortSignal
) {
  if (!session.materialize_url) throw new Error("下载会话缺少 materialize URL");
  await api(session.materialize_url, { method: "POST", signal });
}

export function storedImportStatusMessage(state: StoredImportStatus) {
  return state.status === "failed"
    ? state.error || state.message
    : state.message;
}

/** @internal Exported only for local upload progress verification. */
export function createIntegerProgressReporter(
  onProgress: (progress: number) => void,
  initialProgress = -1
) {
  let lastProgress = initialProgress;
  return (progress: number) => {
    if (!Number.isFinite(progress)) return;
    const normalizedProgress = Math.min(100, Math.max(0, Math.round(progress)));
    if (normalizedProgress === lastProgress) return;
    lastProgress = normalizedProgress;
    onProgress(normalizedProgress);
  };
}

export function uploadLocalRaw(
  session: ImportSessionHandle,
  file: File,
  callbacks: { onProgress: (progress: number) => void; onUploaded: () => void }
) {
  if (!session.upload_url) throw new Error("上传会话缺少 upload URL");
  const request = new XMLHttpRequest();
  // 任务进入上传阶段时已经写入 0%，因此 XHR 只需报告之后真正变化的整数百分比。
  const reportProgress = createIntegerProgressReporter(callbacks.onProgress, 0);
  const promise = new Promise<void>((resolve, reject) => {
    request.open("PUT", session.upload_url!);
    const csrf = getCsrfToken();
    if (csrf) request.setRequestHeader("x-csrf-token", csrf);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) reportProgress((event.loaded / event.total) * 100);
    };
    request.upload.onload = callbacks.onUploaded;
    request.onload = () => {
      const data = parseUploadResponse(request.responseText);
      if (request.status >= 200 && request.status < 300 && data.ok !== false) {
        resolve();
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
  return api<StoredImportCommitResult>(`${adminApiBasePath}/imports/${sessionId}/commit`, {
    method: "POST",
    body: JSON.stringify(draft)
  });
}
