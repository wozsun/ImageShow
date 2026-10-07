import {
  imageVariantUrl,
  type AdminOverviewDto,
  type AdminCheckStatusDto,
  adminApiBasePath,
  adminBasePath
} from "@imageshow/shared/browser";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../../lib/api/client.js";
import { ThumbnailImage } from "../../components/image/ThumbnailImage.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import {
  readyImageProjection,
  useAdminCheckStatus
} from "../../lib/api/ready-image-cache.js";
import { formatBytes } from "../../lib/ui/formatters.js";
import { preloadIntentProps } from "../../lib/ui/preload-intent.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { WorkspaceHeader } from "../../components/layout/WorkspaceHeader.js";
import { WorkspaceScrollBody } from "../../components/layout/WorkspaceScrollBody.js";
import {
  ActionFeedbackOutlet,
  useActionFeedbackTarget
} from "../../components/feedback/ActionFeedbackRegion.js";
import { createActionFeedback, type ActionFeedbackState } from "../../lib/ui/action-feedback.js";
import { useAdminImageDetailCapability } from "../../components/image/useAdminImageDetailCapability.js";
import "../../styles/admin/overview.css";

type OverviewMetric = {
  label: string;
  value?: number | string;
  hint?: string;
  hintTitle?: string;
  to?: string;
};

function readyImageCacheStateLabel(cache: AdminOverviewDto["ready_image_cache"] | undefined) {
  if (!cache) return "读取中";
  if (cache.synchronized) return "已同步";
  if (cache.rebuilding) return "重建中";
  return cache.state === "degraded" ? "已降级" : "不可用";
}

function OverviewMetricCards({ items }: { items: OverviewMetric[] }) {
  return (
    <div className="overview-cards">
      {items.map((item) => {
        const cardContent = (
          <>
            <span className="overview-card-value">{item.value ?? "—"}</span>
            <span className="overview-card-label">{item.label}</span>
            {item.hint && (
              <span className="overview-card-hint" title={item.hintTitle}>
                {item.hint}
              </span>
            )}
          </>
        );
        return item.to ? (
          <Link
            className="overview-card overview-card-link pressable"
            key={item.label}
            to={item.to}
          >
            {cardContent}
          </Link>
        ) : (
          <div className="overview-card" key={item.label}>
            {cardContent}
          </div>
        );
      })}
    </div>
  );
}

export function Overview({ canManageStorage }: { canManageStorage: boolean }) {
  const feedbackTarget = useActionFeedbackTarget("overview");
  const [detailLoadError, setDetailLoadError] = useState<ActionFeedbackState | null>(null);
  const detailCapability = useAdminImageDetailCapability<AdminOverviewDto["recent"][number]>(
    (error) => {
      reportAdminUiError("overview.detail_load", error);
      setDetailLoadError(createActionFeedback("图片详情加载失败，请重新加载页面", "error"));
    }
  );
  const client = useQueryClient();
  const query = useQuery<AdminOverviewDto>({
    queryKey: queryKeys.overview,
    queryFn: ({ signal }) => api(`${adminApiBasePath}/overview`, { signal })
  });
  const cachedCheckStatus = client.getQueryData<AdminCheckStatusDto>(queryKeys.adminCheckStatus);
  const cachedReadyImageStatus = readyImageProjection(cachedCheckStatus);
  const observeReadyImageStatus = Boolean(
    query.data?.ready_image_cache.rebuilding || cachedReadyImageStatus?.rebuilding
  );
  const checkStatusQuery = useAdminCheckStatus({
    enabled: observeReadyImageStatus,
    refreshAfter: query.data?.ready_image_cache.rebuilding
      ? query.dataUpdatedAt
      : 0
  });
  const { data } = query;
  const currentReadyImageStatus = readyImageProjection(checkStatusQuery.data);
  const readyImageStatusIsCurrent = Boolean(
    checkStatusQuery.isSuccess &&
    currentReadyImageStatus &&
    checkStatusQuery.dataUpdatedAt > query.dataUpdatedAt
  );
  const readyImageCache =
    observeReadyImageStatus
      && readyImageStatusIsCurrent
      && currentReadyImageStatus
      ? {
          state: currentReadyImageStatus.state,
          synchronized: currentReadyImageStatus.synchronized === true,
          rebuilding: currentReadyImageStatus.rebuilding,
          item_count: currentReadyImageStatus.item_count,
          current_core_memory_bytes: data?.ready_image_cache.current_core_memory_bytes ?? null,
          current_core_measured_at: data?.ready_image_cache.current_core_measured_at ?? null,
          last_full_rebuild_core_memory_bytes:
            data?.ready_image_cache.last_full_rebuild_core_memory_bytes ?? null,
          last_full_rebuild_measured_at: data?.ready_image_cache.last_full_rebuild_measured_at ?? null
        }
      : data?.ready_image_cache;
  if (query.isError)
    return (
      <QueryErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        fullPage
        reportContext="overview.load"
      />
    );
  const imageCards: OverviewMetric[] = [
    { label: "图库", value: data?.gallery, hint: "已分类展示", to: `${adminBasePath}/images` },
    { label: "主题", value: data?.theme_count, hint: "图库主题数", to: `${adminBasePath}/themes` },
    { label: "标签", value: data?.tag_count, hint: "图库标签数", to: `${adminBasePath}/tags` },
    { label: "作者", value: data?.author_count, hint: "图库作者数", to: `${adminBasePath}/authors` }
  ];
  const deviceCards: OverviewMetric[] = [
    { label: "桌面", value: data?.pc },
    { label: "移动", value: data?.mb },
    { label: "暗色", value: data?.dark },
    { label: "亮色", value: data?.light }
  ];
  const totalSize = (large?: number, medium?: number, small?: number) =>
    large === undefined || medium === undefined || small === undefined ? undefined : formatBytes(large + medium + small);
  const sizeTitle = (large?: number, medium?: number, small?: number) =>
    large === undefined || medium === undefined || small === undefined ? undefined : `大图 ${formatBytes(large)} + 中图 ${formatBytes(medium)} + 小图 ${formatBytes(small)}`;
  const readyImageCacheState = readyImageCacheStateLabel(readyImageCache);
  const currentCoreSize =
    readyImageCache?.current_core_memory_bytes === null ||
    readyImageCache?.current_core_memory_bytes === undefined ||
    !readyImageCache.current_core_measured_at
      ? null
      : formatBytes(readyImageCache.current_core_memory_bytes);
  const fullRebuildCoreSize =
    readyImageCache?.last_full_rebuild_core_memory_bytes === null ||
    readyImageCache?.last_full_rebuild_core_memory_bytes === undefined ||
    !readyImageCache.last_full_rebuild_measured_at
      ? "—"
      : formatBytes(readyImageCache.last_full_rebuild_core_memory_bytes);
  const currentCoreMeasuredAt = readyImageCache?.current_core_measured_at
    ? new Date(readyImageCache.current_core_measured_at).toLocaleString()
    : null;
  const fullRebuildMeasuredAt = readyImageCache?.last_full_rebuild_measured_at
    ? new Date(readyImageCache.last_full_rebuild_measured_at).toLocaleString()
    : null;
  const redisMemoryHint =
    currentCoreSize && currentCoreMeasuredAt
      ? `${currentCoreSize} · ${readyImageCacheState}`
      : fullRebuildCoreSize !== "—" && fullRebuildMeasuredAt
        ? `${fullRebuildCoreSize} · ${readyImageCacheState}`
        : `— · ${readyImageCacheState}`;
  const redisMemoryTitle =
    currentCoreSize && currentCoreMeasuredAt
      ? `当前核心图片投影占用 ${currentCoreSize}，测量于 ${currentCoreMeasuredAt}`
      : fullRebuildCoreSize !== "—" && fullRebuildMeasuredAt
        ? `当前核心占用未知；最近完整重建核心占用 ${fullRebuildCoreSize}，测量于 ${fullRebuildMeasuredAt}`
        : "当前核心图片投影占用未知";
  const storageCards: OverviewMetric[] = [
    {
      label: "Redis 缓存",
      value: readyImageCache?.item_count ?? undefined,
      hint: redisMemoryHint,
      hintTitle: redisMemoryTitle,
      to: `${adminBasePath}/check`
    },
    // 本地存储 / 其它存储的三档合计占用，以及当前存储后端数。
    {
      label: "本地存储",
      value: data?.local,
      hint: totalSize(data?.local_large_bytes, data?.local_medium_bytes, data?.local_small_bytes),
      hintTitle: sizeTitle(data?.local_large_bytes, data?.local_medium_bytes, data?.local_small_bytes)
    },
    {
      label: "其它存储",
      value: data?.nonlocal,
      hint: totalSize(data?.nonlocal_large_bytes, data?.nonlocal_medium_bytes, data?.nonlocal_small_bytes),
      hintTitle: sizeTitle(data?.nonlocal_large_bytes, data?.nonlocal_medium_bytes, data?.nonlocal_small_bytes)
    },
    {
      label: "存储后端",
      value: data?.backend_count,
      to: canManageStorage ? `${adminBasePath}/storage` : undefined
    }
  ];
  return (
    <section className="workspace workspace-contained overview">
      <WorkspaceHeader
        title="概览"
        description={`图片库与存储概况 · 共 ${data?.total ?? 0} 张图片`}
        feedbackTarget={feedbackTarget}
      />

      <WorkspaceScrollBody>
        <div className="overview-grid">
          <div className="overview-main">
            <OverviewMetricCards items={imageCards} />

            <div className="overview-section">
              <h2>设备与亮度</h2>
              <OverviewMetricCards items={deviceCards} />
            </div>

            <div className="overview-section">
              <h2>存储与大小</h2>
              <OverviewMetricCards items={storageCards} />
            </div>
          </div>

          <div className="overview-side">
            {!!data?.top_themes?.length && (
              <div className="overview-section">
                <h2>热门主题</h2>
                <div className="overview-themes">
                  {data.top_themes.map((item) => (
                    <span className="overview-theme-chip" key={item.theme}>
                      {item.theme}
                      <b>{item.count}</b>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {!!data?.recent?.length && (
              <div className="overview-section">
                <h2>最近上传</h2>
                <div className="overview-recent">
                  {data.recent.map((img) => (
                    <button
                      type="button"
                      className="overview-recent-item"
                      key={img.id}
                      disabled={detailCapability.pendingItemId === img.id}
                      aria-busy={detailCapability.pendingItemId === img.id || undefined}
                      aria-label={`查看图片详情：${img.title || img.id}`}
                      title={img.title || img.id}
                      {...preloadIntentProps(detailCapability.preload)}
                      onClick={(event) => {
                        setDetailLoadError(null);
                        void detailCapability.open(img, event.currentTarget);
                      }}
                    >
                      <ThumbnailImage src={imageVariantUrl(img, "small")} alt="" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </WorkspaceScrollBody>
      {detailLoadError && (
        <ActionFeedbackOutlet
          feedback={detailLoadError}
          target={feedbackTarget}
          onClose={() => setDetailLoadError(null)}
        />
      )}
      {detailCapability.item && detailCapability.Modal && (
        <detailCapability.Modal
          item={detailCapability.item}
          onClose={detailCapability.close}
          returnFocusRef={detailCapability.returnFocusRef}
          storageLabel={detailCapability.item.storage_label}
          admin
        />
      )}
    </section>
  );
}
