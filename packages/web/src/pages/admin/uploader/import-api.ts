import {
  importActionScopeHeader,
  importActionPath,
  importCancelPath,
  importCommitPath,
  importDuplicatesPath,
  importSnapshotPath,
  importStatusPath,
  importUpdatePath,
  remoteImportAcceptPath,
  uploadCredentialHeader,
  uploadIntentPath,
  uploadRawPath,
  type ImportCancelInputDto,
  type ImportCancelResultDto,
  type ImportCommitInputDto,
  type ImportCommitResultDto,
  type ImportDuplicateDetailsInputDto,
  type ImportDuplicateDetailsResultDto,
  type ImportQueueSnapshotInputDto,
  type ImportQueueSnapshotDto,
  type ImportQueueActionInputDto,
  type ImportQueueActionResultDto,
  type ImportSessionPairDto,
  type ImportStatusResultDto,
  type ImportSessionUpdateInputDto,
  type ImportSessionUpdateResultDto,
  type JsonlManifestItemDto,
  type JsonlManifestParseErrorDto,
  type JsonlManifestResultDto,
  type RemoteImportAcceptInputDto,
  type RemoteImportAcceptResultDto,
  type UploadIntentInputDto,
  type UploadIntentResultDto,
  type UploadRawResultDto,
  type WeiboImportParseErrorDto,
  type WeiboImportResultDto
} from "@imageshow/shared/browser";
import { api, getCsrfToken } from "../../../lib/api/client.js";
import { adminApiBasePath } from "../../../lib/constants.js";
import { createIntegerProgressReporter } from "./upload-progress.js";

export type JsonlManifestItem = JsonlManifestItemDto;
export type JsonlManifestParseError = JsonlManifestParseErrorDto;
export type JsonlManifestResult = JsonlManifestResultDto;
export type WeiboImportParseError = WeiboImportParseErrorDto;
export type WeiboImportResult = WeiboImportResultDto;

export function createUploadIntents(
  input: UploadIntentInputDto,
  signal?: AbortSignal
) {
  return api<UploadIntentResultDto>(uploadIntentPath, {
    method: "POST",
    body: JSON.stringify(input),
    signal
  });
}

export function acceptRemoteImports(
  input: RemoteImportAcceptInputDto,
  signal?: AbortSignal
) {
  return api<RemoteImportAcceptResultDto>(remoteImportAcceptPath, {
    method: "POST",
    body: JSON.stringify(input),
    signal
  });
}

export function getImportStatuses(
  items: ImportSessionPairDto[],
  signal?: AbortSignal
) {
  return api<ImportStatusResultDto>(importStatusPath, {
    method: "POST",
    body: JSON.stringify({ items }),
    signal
  }).then((result) => result.items);
}

export function updateStoredImports(
  items: ImportSessionUpdateInputDto["items"]
) {
  return api<ImportSessionUpdateResultDto>(importUpdatePath, {
    method: "POST",
    body: JSON.stringify({ items } satisfies ImportSessionUpdateInputDto)
  });
}

export function getImportDuplicateDetails(
  md5s: ImportDuplicateDetailsInputDto["md5s"],
  signal?: AbortSignal
) {
  return api<ImportDuplicateDetailsResultDto>(importDuplicatesPath, {
    method: "POST",
    body: JSON.stringify({ md5s } satisfies ImportDuplicateDetailsInputDto),
    signal
  });
}

export function executeImportQueueAction(
  input: ImportQueueActionInputDto,
  actionScope: string,
  signal?: AbortSignal
) {
  return api<ImportQueueActionResultDto>(importActionPath, {
    method: "POST",
    headers: { [importActionScopeHeader]: actionScope },
    body: JSON.stringify(input),
    signal
  });
}

export function getImportQueueSnapshot(
  input: ImportQueueSnapshotInputDto,
  actionScope: string,
  signal?: AbortSignal
) {
  const query = new URLSearchParams({
    queue: input.queue,
    offset: String(input.offset),
    limit: String(input.limit)
  });
  return api<ImportQueueSnapshotDto>(`${importSnapshotPath}?${query}`, {
    method: "POST",
    headers: { [importActionScopeHeader]: actionScope },
    body: JSON.stringify({
      exclude_items: input.exclude_items,
      include_items: input.include_items
    }),
    signal
  });
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

type UploadResponse = UploadRawResultDto & { ok: true };

export function uploadLocalRaw(
  credential: string,
  file: File,
  callbacks: { onProgress: (progress: number) => void }
) {
  const request = new XMLHttpRequest();
  const reportProgress = createIntegerProgressReporter(callbacks.onProgress, 0);
  const promise = new Promise<UploadRawResultDto>((resolve, reject) => {
    request.open("PUT", uploadRawPath);
    const csrf = getCsrfToken();
    if (csrf) request.setRequestHeader("x-csrf-token", csrf);
    request.setRequestHeader(uploadCredentialHeader, credential);
    request.setRequestHeader(
      "content-type",
      file.type || "application/octet-stream"
    );
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        reportProgress((event.loaded / event.total) * 100);
      }
    };
    request.onload = () => {
      const data = parseUploadResponse(request.responseText);
      if (
        request.status >= 200
        && request.status < 300
        && data.ok === true
        && typeof data.session_id === "string"
        && typeof data.image_id === "string"
        && data.status === "accepted"
        && Number.isSafeInteger(data.version)
      ) {
        resolve(data as UploadRawResultDto);
        return;
      }
      const responseError = data.error;
      const message = typeof responseError === "string"
        ? responseError
        : responseError
          && typeof responseError === "object"
          && "message" in responseError
          && typeof responseError.message === "string"
          ? responseError.message
          : `上传失败（HTTP ${request.status}）`;
      reject(new Error(message));
    };
    request.onerror = () => reject(new Error("上传网络请求失败"));
    request.onabort = () => reject(new DOMException("上传已取消", "AbortError"));
    request.send(file);
  });
  return { promise, abort: () => request.abort() };
}

function parseUploadResponse(text: string): Partial<UploadResponse> & {
  error?: unknown;
} {
  try {
    return JSON.parse(text || "{}") as Partial<UploadResponse> & {
      error?: unknown;
    };
  } catch {
    return {};
  }
}

export function cancelStoredImports(items: ImportCancelInputDto["items"]) {
  return api<ImportCancelResultDto>(importCancelPath, {
    method: "POST",
    body: JSON.stringify({ items } satisfies ImportCancelInputDto)
  });
}

export function commitStoredImports(items: ImportCommitInputDto["items"]) {
  return api<ImportCommitResultDto>(importCommitPath, {
    method: "POST",
    body: JSON.stringify({ items } satisfies ImportCommitInputDto)
  });
}
