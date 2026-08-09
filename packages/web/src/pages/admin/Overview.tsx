import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type {
  AdminOverviewDto,
  AdminCheckStatusDto
} from "@imageshow/shared/browser";
import { api } from "../../lib/api/client.js";
import { ThumbImage } from "../../components/image/ThumbImage.js";
import { adminApiBasePath, adminBasePath } from "../../lib/constants.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import {
  readyImageProjection,
  useAdminCheckStatus
} from "../../lib/api/ready-image-cache.js";
import { formatBytes } from "../../lib/ui/formatters.js";
import { preloadIntentProps } from "../../lib/ui/preload-intent.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { useAdminImageDetailCapability } from "../../components/image/useAdminImageDetailCapability.js";
import "../../styles/admin/overview.css";

type OverviewMetric = { label: string; value?: number | string; hint?: string; hintTitle?: string; to?: string };

function redisCacheStateLabel(
  cache: AdminOverviewDto["redis_cache"] | undefined
) {
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
            {item.hint && <span className="overview-card-hint" title={item.hintTitle}>{item.hint}</span>}
          </>
        );
        return item.to
          ? (
            <Link className="overview-card overview-card-link pressable" key={item.label} to={item.to}>
              {cardContent}
            </Link>
          )
          : <div className="overview-card" key={item.label}>{cardContent}</div>;
      })}
    </div>
  );
}

export function Overview({ canManageStorage }: { canManageStorage: boolean }) {
  const [detailLoadError, setDetailLoadError] = useState("");
  const detailCapability = useAdminImageDetailCapability<
    AdminOverviewDto["recent"][number]
  >((error) => {
    reportAdminUiError("overview.detail_load", error);
    setDetailLoadError("图片详情加载失败，请重新加载页面");
  });
  const client = useQueryClient();
  const query = useQuery<AdminOverviewDto>({ queryKey: queryKeys.overview, queryFn: ({ signal }) => api(`${adminApiBasePath}/overview`, { signal }) });
  const cachedCheckStatus = client.getQueryData<AdminCheckStatusDto>(
    queryKeys.adminCheckStatus
  );
  const cachedReadyImageStatus = readyImageProjection(cachedCheckStatus);
  const observeReadyImageStatus = Boolean(
    query.data?.redis_cache.rebuilding || cachedReadyImageStatus?.rebuilding
  );
  const checkStatusQuery = useAdminCheckStatus(
    {
      enabled: observeReadyImageStatus,
      refreshAfter: query.data?.redis_cache.rebuilding
        ? query.dataUpdatedAt
        : 0
    }
  );
  const { data } = query;
  const currentReadyImageStatus = readyImageProjection(checkStatusQuery.data);
  const readyImageStatusIsCurrent = Boolean(
    checkStatusQuery.isSuccess
    && currentReadyImageStatus
    && checkStatusQuery.dataUpdatedAt > query.dataUpdatedAt
  );
  const redisCache = observeReadyImageStatus
    && readyImageStatusIsCurrent
    && currentReadyImageStatus
    ? {
        state: currentReadyImageStatus.state,
        synchronized: currentReadyImageStatus.synchronized === true,
        rebuilding: currentReadyImageStatus.rebuilding,
        item_count: currentReadyImageStatus.item_count,
        memory_bytes: currentReadyImageStatus.memory_bytes
      }
    : data?.redis_cache;
  if (query.isError) return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} fullPage reportContext="overview.load" />;
  const imageCards: OverviewMetric[] = [
    { label: "图库", value: data?.gallery, hint: "已分类展示", to: `${adminBasePath}/images` },
    { label: "未设置主题", value: data?.theme_unset, hint: "缺少主题", to: `${adminBasePath}/images?view=unset` },
    { label: "回收站", value: data?.trash, hint: "可恢复", to: `${adminBasePath}/images?view=deleted` },
    { label: "主题", value: data?.theme_count, hint: "图库主题数", to: `${adminBasePath}/themes` }
  ];
  const deviceCards: OverviewMetric[] = [
    { label: "桌面", value: data?.pc },
    { label: "移动", value: data?.mb },
    { label: "暗色", value: data?.dark },
    { label: "亮色", value: data?.light }
  ];
  // 原图大小 + 缩略图大小，用「+」拼成卡片副标题。
  const sizePair = (first?: number, second?: number) =>
    first === undefined || second === undefined ? undefined : `${formatBytes(first)} + ${formatBytes(second)}`;
  // 卡片副标题只显示「X + Y」两个体积；hover 的 title 再标明每段各是什么，避免用户不清楚 + 两边的含义。
  const sizeTitle = (firstLabel: string, first: number | undefined, secondLabel: string, second: number | undefined) =>
    first === undefined || second === undefined ? undefined : `${firstLabel} ${formatBytes(first)} + ${secondLabel} ${formatBytes(second)}`;
  const redisCacheState = redisCacheStateLabel(redisCache);
  const redisCacheSize = redisCache?.memory_bytes === null
    || redisCache?.memory_bytes === undefined
    ? "大小未知"
    : formatBytes(redisCache.memory_bytes);
  const storageCards: OverviewMetric[] = [
    {
      label: "Redis 缓存",
      value: redisCache?.item_count ?? undefined,
      hint: `${redisCacheSize} · ${redisCacheState}`,
      hintTitle: "统一图片投影占用与同步状态",
      to: `${adminBasePath}/check`
    },
    // 本地存储 / 其它存储的图片与缩略图占用，以及当前存储后端数。
    { label: "本地存储", value: data?.local,
      hint: sizePair(data?.local_image_size, data?.local_thumb_size),
      hintTitle: sizeTitle("原图", data?.local_image_size, "缩略图", data?.local_thumb_size) },
    { label: "其它存储", value: data?.nonlocal,
      hint: sizePair(data?.nonlocal_image_size, data?.nonlocal_thumb_size),
      hintTitle: sizeTitle("原图", data?.nonlocal_image_size, "缩略图", data?.nonlocal_thumb_size) },
    {
      label: "存储后端",
      value: data?.backend_count,
      to: canManageStorage ? `${adminBasePath}/storage` : undefined
    }
  ];
  return (
    <section className="workspace overview">
      <header className="workspace-head">
        <div>
          <h1>概览</h1>
          <p>图片库与存储概况 · 共 {data?.total ?? 0} 张图片</p>
        </div>
      </header>

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
                  <span className="overview-theme-chip" key={item.theme}>{item.theme}<b>{item.count}</b></span>
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
                      setDetailLoadError("");
                      void detailCapability.open(img, event.currentTarget);
                    }}
                  >
                    <ThumbImage src={img.thumb_url} alt="" />
                  </button>
                ))}
              </div>
              {detailLoadError && (
                <p className="admin-error" role="alert">{detailLoadError}</p>
              )}
            </div>
          )}
        </div>
      </div>
      {detailCapability.item && detailCapability.Modal && (
        <detailCapability.Modal
          item={detailCapability.item}
          onClose={detailCapability.close}
          returnFocusRef={detailCapability.returnFocusRef}
          admin
        />
      )}
    </section>
  );
}
