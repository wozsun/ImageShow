import { useEffect, useState } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiClientError } from "../../lib/api/client.js";
import { adminApiBasePath, queryKeys } from "../../lib/constants.js";
import { clearSessionProbeHint, hasSessionProbeHint } from "../../lib/api/site-data.js";
import { errorMessage, formatDate } from "../../lib/ui/formatters.js";
import type { ImageAdminInfo, ImageItem } from "../../lib/types.js";

const MD5_RESERVE = "0".repeat(32);

function adminImageInfoQueryOptions(imageId: string) {
  return queryOptions<ImageAdminInfo>({
    queryKey: [...queryKeys.adminImageInfo, imageId],
    queryFn: ({ signal }) => api(`${adminApiBasePath}/images/${encodeURIComponent(imageId)}/admin-info`, { signal }),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000
  });
}

function unresolvedValue(admin: boolean, loading: boolean, failed: boolean) {
  if (admin) return "未记录";
  if (loading) return "加载中…";
  if (failed) return "加载失败";
  return "未记录";
}

export function ImageAdminDetails({
  imageId,
  adminItem,
  storageLabel
}: {
  imageId: string;
  adminItem: ImageItem | null;
  storageLabel: string;
}) {
  const admin = Boolean(adminItem);
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [accessAvailable, setAccessAvailable] = useState(() => admin || hasSessionProbeHint());
  const adminInfoOptions = adminImageInfoQueryOptions(imageId);
  const query = useQuery({
    ...adminInfoOptions,
    enabled: !admin && accessAvailable && expanded,
  });
  const adminInfo = query.data?.id === imageId ? query.data : undefined;

  useEffect(() => {
    if (admin || !isApiClientError(query.error) || query.error.status !== 401) return;
    clearSessionProbeHint();
    setAccessAvailable(false);
    setExpanded(false);
  }, [admin, query.error]);

  if (!accessAvailable) return null;

  const loading = !admin && query.isFetching && !adminInfo;
  const failed = !admin && query.isError && !query.isFetching;
  const fallback = unresolvedValue(admin, loading, failed);
  const md5 = adminItem?.md5 || adminInfo?.md5 || fallback;
  const storage = adminItem ? storageLabel || fallback : adminInfo?.storage_label || fallback;
  const createdAt = adminItem?.created_at ?? adminInfo?.created_at;
  const updatedAt = adminItem?.updated_at ?? adminInfo?.updated_at;
  const prefetchAdminInfo = () => {
    if (admin || !accessAvailable) return;
    void queryClient.prefetchQuery(adminInfoOptions);
  };

  return (
    <section className="image-detail-admin-details">
      <button
        type="button"
        className="image-detail-admin-toggle pressable"
        aria-expanded={expanded}
        onPointerEnter={prefetchAdminInfo}
        onFocus={prefetchAdminInfo}
        onPointerDown={prefetchAdminInfo}
        onClick={() => setExpanded((current) => !current)}
      >
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        管理信息
      </button>
      {expanded && (
        <div className="image-detail-admin-panel">
          <dl>
            <dt>UUID</dt><dd className="image-detail-admin-uuid">{imageId}</dd>
            <dt>MD5</dt>
            <dd className="image-detail-admin-md5">
              <span className="image-detail-admin-md5-reserve" aria-hidden="true">{MD5_RESERVE}</span>
              <span>{md5}</span>
            </dd>
            <dt>存储</dt><dd>{storage}</dd>
            <dt>导入时间</dt><dd>{createdAt ? formatDate(createdAt) : fallback}</dd>
            <dt>更新时间</dt><dd>{updatedAt ? formatDate(updatedAt) : fallback}</dd>
            {adminItem?.deleted_at && <><dt>删除时间</dt><dd>{formatDate(adminItem.deleted_at)}</dd></>}
          </dl>
          {failed && (
            <div className="image-detail-admin-error" role="alert" title={errorMessage(query.error)}>
              <span>管理信息加载失败</span>
              <button type="button" onClick={() => void query.refetch()}>重试</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
