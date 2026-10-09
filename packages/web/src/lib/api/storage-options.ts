import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "./client.js";
import {
  adminApiBasePath,
  type StorageBackendOptionDto,
  type StorageBackendOptionsResponseDto
} from "@imageshow/shared/browser";
import { queryKeys } from "./query-keys.js";
import { readRequestRetryOptions } from "./read-request-retry.js";
import { requestWithDeadline } from "./request-deadline.js";

export type StorageBackendOption = StorageBackendOptionDto;

// 存储后端选项（slug + 显示名 + 标记），供上传/迁移目标选择器与检查页共用。所有
// 调用方统一走这一个 queryKey 与 staleTime，从而自动去重、缓存一致（后端很少变动，缓存 5 分钟）。
// enabled=false 时（公共画廊里未登录的访客、未打开的内容接入窗口等）不发请求，仍可安全调用。
export const storageOptionsQueryOptions = queryOptions<StorageBackendOptionsResponseDto>({
  queryKey: queryKeys.storageOptions,
  queryFn: ({ signal }) =>
    requestWithDeadline(
      (requestSignal) => api(`${adminApiBasePath}/storage/options`, { signal: requestSignal }),
      signal
    ),
  ...readRequestRetryOptions,
  staleTime: 5 * 60 * 1000
});

export function useStorageOptions(enabled = true) {
  return useQuery({
    ...storageOptionsQueryOptions,
    enabled
  });
}
