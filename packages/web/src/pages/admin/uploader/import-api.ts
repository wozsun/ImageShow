import { api, getCsrfToken } from "../../../lib/api/client.js";
import { adminApiBasePath } from "../../../lib/constants.js";
import { createIntegerProgressReporter } from "./upload-progress.js";
import type {
  ImportSessionCreateDto,
  ImportSessionHandleDto,
  JsonlManifestItemDto,
  JsonlManifestParseErrorDto,
  JsonlManifestResultDto,
  PreparedImportDto,
  StoredImportCommitResultDto,
  StoredImportBatchCommitItemInputDto,
  StoredImportBatchCommitResultDto,
  StoredImportStatusListDto,
  StoredImportStatusDto,
  WeiboImportParseErrorDto,
  WeiboImportResultDto
} from "@imageshow/shared/browser";

export type PreparedImport = PreparedImportDto;
export type ImportSessionHandle = ImportSessionHandleDto;
export type ImportSessionCreateInput = ImportSessionCreateDto;
export type JsonlManifestItem = JsonlManifestItemDto;
export type JsonlManifestParseError = JsonlManifestParseErrorDto;
export type JsonlManifestResult = JsonlManifestResultDto;
export type WeiboImportParseError = WeiboImportParseErrorDto;
export type WeiboImportResult = WeiboImportResultDto;
export type StoredImportStatus = StoredImportStatusDto;
export type StoredImportCommitResult = StoredImportCommitResultDto;
export type StoredImportBatchCommitResult = StoredImportBatchCommitResultDto;

export function getStoredImportStatuses(ids: string[], signal?: AbortSignal) {
  const query = encodeURIComponent(ids.join(","));
  return api<StoredImportStatusListDto>(
    `${adminApiBasePath}/imports/status?ids=${query}`,
    { signal }
  ).then((result) => result.items);
}

export async function getStoredImportStatus(id: string, signal?: AbortSignal) {
  const states = await getStoredImportStatuses([id], signal);
  return states[0];
}

export function createImportSession(input: ImportSessionCreateInput, signal?: AbortSignal) {
  return api<ImportSessionHandle>(`${adminApiBasePath}/imports/create`, { method: "POST", body: JSON.stringify(input), signal });
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

export function uploadLocalRaw(
  session: ImportSessionHandle,
  file: File,
  callbacks: { onProgress: (progress: number) => void }
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

export function commitStoredImports(
  items: StoredImportBatchCommitItemInputDto[]
) {
  return api<StoredImportBatchCommitResult>(
    `${adminApiBasePath}/imports/commit-batch`,
    {
      method: "POST",
      body: JSON.stringify({ items })
    }
  );
}
