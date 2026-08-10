import { queryOptions } from "@tanstack/react-query";
import type { BatchImageSnapshotResponseDto } from "@imageshow/shared/browser";
import { api } from "./client.js";
import { queryKeys } from "./query-keys.js";
import { adminApiBasePath } from "../constants.js";

export function readEditableImageSnapshots(
  imageIds: string[],
  signal?: AbortSignal
) {
  return api<BatchImageSnapshotResponseDto>(
    `${adminApiBasePath}/images/batch-snapshot`,
    {
      method: "POST",
      body: JSON.stringify({ ids: imageIds }),
      signal
    }
  );
}

/**
 * 单图详情编辑与批量编辑恢复共用服务端快照契约；这里再为单图意图预取提供稳定缓存键，
 * 让 hover/focus/pointerdown 与随后 click 复用同一请求。
 */
export function imageEditSnapshotQueryOptions(imageId: string) {
  return queryOptions<BatchImageSnapshotResponseDto>({
    queryKey: [...queryKeys.adminImageEditSnapshot, imageId],
    queryFn: ({ signal }) => readEditableImageSnapshots([imageId], signal),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false
  });
}
