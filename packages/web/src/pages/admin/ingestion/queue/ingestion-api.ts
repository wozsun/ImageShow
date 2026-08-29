import {
  ingestionActionScopeHeader,
  ingestionActionPath,
  ingestionCancelPath,
  ingestionCommitPath,
  ingestionDuplicatesPath,
  ingestionSnapshotPath,
  ingestionStatusPath,
  ingestionUpdatePath,
  importAcceptPath,
  importJsonlParsePath,
  importWeiboParsePath,
  uploadCredentialHeader,
  uploadIntentPath,
  uploadRawPath,
  type IngestionCancelInputDto,
  type IngestionCancelResultDto,
  type IngestionCommitInputDto,
  type IngestionCommitResultDto,
  type IngestionDuplicateDetailsInputDto,
  type IngestionDuplicateDetailsResultDto,
  type IngestionQueueSnapshotInputDto,
  type IngestionQueueSnapshotDto,
  type IngestionQueueActionInputDto,
  type IngestionQueueActionResultDto,
  type IngestionSessionPairDto,
  type IngestionStatusResultDto,
  type IngestionSessionUpdateInputDto,
  type IngestionSessionUpdateResultDto,
  type ImportManifestItemDto,
  type ImportManifestParseErrorDto,
  type ImportManifestResultDto,
  type ImportAcceptInputDto,
  type ImportAcceptResultDto,
  type UploadIntentInputDto,
  type UploadIntentResultDto,
  type UploadRawResultDto,
  type WeiboImportParseErrorDto,
  type WeiboImportResultDto
} from "@imageshow/shared/browser";
import { api, getCsrfToken } from "../../../../lib/api/client.js";

export type ImportManifestItem = ImportManifestItemDto;
export type ImportManifestParseError = ImportManifestParseErrorDto;
export type JsonlManifestResult = ImportManifestResultDto;
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

export function acceptImports(
  input: ImportAcceptInputDto,
  signal?: AbortSignal
) {
  return api<ImportAcceptResultDto>(importAcceptPath, {
    method: "POST",
    body: JSON.stringify(input),
    signal
  });
}

export function getIngestionStatuses(
  items: IngestionSessionPairDto[],
  signal?: AbortSignal
) {
  return api<IngestionStatusResultDto>(ingestionStatusPath, {
    method: "POST",
    body: JSON.stringify({ items }),
    signal
  }).then((result) => result.items);
}

export function updateStoredIngestions(
  items: IngestionSessionUpdateInputDto["items"]
) {
  return api<IngestionSessionUpdateResultDto>(ingestionUpdatePath, {
    method: "POST",
    body: JSON.stringify({ items } satisfies IngestionSessionUpdateInputDto)
  });
}

export function getIngestionDuplicateDetails(
  md5s: IngestionDuplicateDetailsInputDto["md5s"],
  signal?: AbortSignal
) {
  return api<IngestionDuplicateDetailsResultDto>(ingestionDuplicatesPath, {
    method: "POST",
    body: JSON.stringify({ md5s } satisfies IngestionDuplicateDetailsInputDto),
    signal
  });
}

export function executeIngestionQueueAction(
  input: IngestionQueueActionInputDto,
  actionScope: string,
  signal?: AbortSignal
) {
  return api<IngestionQueueActionResultDto>(ingestionActionPath, {
    method: "POST",
    headers: { [ingestionActionScopeHeader]: actionScope },
    body: JSON.stringify(input),
    signal
  });
}

export function getIngestionQueueSnapshot(
  input: IngestionQueueSnapshotInputDto,
  actionScope: string,
  signal?: AbortSignal
) {
  const query = new URLSearchParams({
    queue: input.queue,
    offset: String(input.offset),
    limit: String(input.limit)
  });
  return api<IngestionQueueSnapshotDto>(`${ingestionSnapshotPath}?${query}`, {
    method: "POST",
    headers: { [ingestionActionScopeHeader]: actionScope },
    body: JSON.stringify({
      exclude_items: input.exclude_items,
      include_items: input.include_items
    }),
    signal
  });
}

export function parseImportJsonl(content: string, signal?: AbortSignal) {
  return api<JsonlManifestResult>(importJsonlParsePath, {
    method: "POST",
    body: JSON.stringify({ content }),
    signal
  });
}

export function parseWeiboImport(urls: string[], signal?: AbortSignal) {
  return api<WeiboImportResult>(importWeiboParsePath, {
    method: "POST",
    body: JSON.stringify({ urls }),
    signal
  });
}

type UploadResponse = UploadRawResultDto & { ok: true };

export function uploadRaw(
  credential: string,
  file: File,
  callbacks: { onProgress: (progress: number) => void }
) {
  const request = new XMLHttpRequest();
  let lastProgress = 0;
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
        const rawProgress = (event.loaded / event.total) * 100;
        if (!Number.isFinite(rawProgress)) return;
        const progress = Math.min(
          100,
          Math.max(0, Math.round(rawProgress))
        );
        if (progress !== lastProgress) {
          lastProgress = progress;
          callbacks.onProgress(progress);
        }
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

export function cancelStoredIngestions(items: IngestionCancelInputDto["items"]) {
  return api<IngestionCancelResultDto>(ingestionCancelPath, {
    method: "POST",
    body: JSON.stringify({ items } satisfies IngestionCancelInputDto)
  });
}

export function commitStoredIngestions(items: IngestionCommitInputDto["items"]) {
  return api<IngestionCommitResultDto>(ingestionCommitPath, {
    method: "POST",
    body: JSON.stringify({ items } satisfies IngestionCommitInputDto)
  });
}
