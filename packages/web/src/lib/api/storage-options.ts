import { useMemo } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "./client.js";
import { adminApiBasePath } from "../constants.js";
import { storageBackendLabel } from "../ui/select-options.js";
import { queryKeys } from "./query-keys.js";
import type {
  StorageBackendOptionDto,
  StorageBackendOptionsResponseDto
} from "@imageshow/shared/browser";

export type StorageBackendOption = StorageBackendOptionDto;

// 由后端选项列表构建「图片 → 所在存储显示名」的解析函数，并回退到 slug 标签
// （本地存储→「本地存储」，其余→slug 本身）。纯函数，供已自行持有后端列表的调用方
// （如图片编辑列表，它本就为所在存储名称拉过该列表）直接复用同一份查询结果。
export function storageNameResolver(backends: StorageBackendOption[]) {
  const nameBySlug = new Map(
    backends.map((backend) => [backend.slug, backend.display_name || storageBackendLabel(backend.slug)] as const)
  );
  return (item: { storage_slug: string }) =>
    nameBySlug.get(item.storage_slug) || storageBackendLabel(item.storage_slug);
}

// 启用的存储后端列表（slug + 显示名 + 标记），供上传/迁移目标选择器、检查页与存储名解析共用。所有
// 调用方统一走这一个 queryKey 与 staleTime，从而自动去重、缓存一致（后端很少变动，缓存 5 分钟）。
// enabled=false 时（公共画廊里未登录的访客、未打开的内容接入窗口等）不发请求，仍可安全调用。
export const storageOptionsQueryOptions =
  queryOptions<StorageBackendOptionsResponseDto>({
    queryKey: queryKeys.storageOptions,
    queryFn: ({ signal }) => api(`${adminApiBasePath}/storage/options`, { signal }),
    staleTime: 5 * 60 * 1000
  });

export function useStorageOptions(enabled = true) {
  return useQuery({
    ...storageOptionsQueryOptions,
    enabled
  });
}

// 图片管理列表用这个 hook：列表载荷只有 storage_slug、没有 display_name，于是复用上面的共享
// 查询取后端列表并套用解析函数。enabled=false 时回退到 slug 标签。
export function useStorageNameResolver(enabled = true) {
  const { data } = useStorageOptions(enabled);
  return useMemo(() => storageNameResolver(data?.backends ?? []), [data]);
}
