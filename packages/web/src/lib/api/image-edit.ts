import { type ImageSnapshotResponseDto, adminApiBasePath } from "@imageshow/shared/browser";
import { api } from "./client.js";
import { retryReadRequest } from "./read-request-retry.js";

export function readEditableImageSnapshots(
  imageIds: string[],
  signal?: AbortSignal,
  markGroup?: string
) {
  // POST 仅查询快照；冻结同一批 ID，重试不改变本次读取意图。
  const body = JSON.stringify({ ids: imageIds, mark_group: markGroup });
  return retryReadRequest(
    (requestSignal) =>
      api<ImageSnapshotResponseDto>(`${adminApiBasePath}/images/snapshot`, {
        method: "POST",
        body,
        signal: requestSignal
      }),
    signal
  );
}
