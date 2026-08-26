import { useEffect, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  AdminCheckStatusDto
} from "@imageshow/shared/browser";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { StableButtonLabel } from "../../../components/data-display/StableButtonLabel.js";
import {
  readyImageProjection
} from "../../../lib/api/ready-image-cache.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import {
  formatBytes,
  revisionFingerprint
} from "../../../lib/ui/formatters.js";
import type {
  ReadyImageProjectionUsageSnapshot
} from "./check-redis-inspection.js";

function formatTime(value: string | null) {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

function formatDuration(value: number | null) {
  if (value === null) return "—";
  if (value < 1_000) return `${value} 毫秒`;
  const seconds = value / 1_000;
  return seconds < 60
    ? `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`
    : `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}

export function ReadyImageCachePanel({
  query,
  projectionUsage = null,
  projectionUsageNotice = "",
  maintenanceBusy = false,
  maintenanceError = "",
  onRefreshSuccess,
  reportQueryError = true,
  renderMaintenanceAction
}: {
  query: UseQueryResult<AdminCheckStatusDto, Error>;
  projectionUsage?: ReadyImageProjectionUsageSnapshot | null;
  projectionUsageNotice?: string;
  maintenanceBusy?: boolean;
  maintenanceError?: string;
  onRefreshSuccess?: () => void;
  reportQueryError?: boolean;
  renderMaintenanceAction?: (state: { disabled: boolean }) => ReactNode;
}) {
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const status = readyImageProjection(query.data);

  useEffect(() => {
    if (!reportQueryError || !query.error) return;
    reportAdminUiError("check.status", query.error);
  }, [query.error, reportQueryError]);

  const refresh = async () => {
    setManualRefreshing(true);
    try {
      const result = await query.refetch();
      if (result.isSuccess) onRefreshSuccess?.();
    } finally {
      setManualRefreshing(false);
    }
  };

  const redisFailure = query.data?.redis.status === "error"
    ? query.data.redis.error
    : null;
  const healthy = Boolean(status?.synchronized === true && !status.rebuilding);
  const statusError = query.isError
    ? "无法读取检查状态，请稍后重试。"
    : redisFailure
      ? `Redis 状态读取失败（${redisFailure.category}）：${redisFailure.message}`
      : "";
  const busy = manualRefreshing || maintenanceBusy;
  const coreOccupancy = {
    key_count: projectionUsage?.core.key_count ?? null,
    count: status?.item_count ?? null,
    memory_bytes: projectionUsage?.core.memory_bytes
      ?? status?.last_full_rebuild_core_memory_bytes
      ?? null
  };
  const derivedOccupancy = projectionUsage
    ? {
        key_count: projectionUsage.derived.key_count,
        count: projectionUsage.derived.member_count,
        memory_bytes: projectionUsage.derived.memory_bytes
      }
    : null;
  const deepMeasuredAt = projectionUsage
    ? formatTime(projectionUsage.measured_at)
    : null;
  const projectionUsageNoticePrefix = projectionUsageNotice
    ? `${projectionUsageNotice} `
    : "";
  const coreDetails = projectionUsage
    ? `${projectionUsageNoticePrefix}图片成员来自当前轻量状态；键数和内存来自最近一次完整 Redis 深检快照，测量于 ${deepMeasuredAt}。`
    : status?.last_full_rebuild_measured_at
      ? `${projectionUsageNoticePrefix}图片成员来自当前轻量状态；内存为最近完整重建快照，测量于 ${formatTime(
          status.last_full_rebuild_measured_at
        )}；当前键数需完成 Redis 检测后显示。`
      : `${projectionUsageNoticePrefix}图片成员来自当前轻量状态；键数和内存需完成 Redis 检测后显示。`;
  const derivedDetails = projectionUsage
    ? `${projectionUsageNoticePrefix}最近一次完整 Redis 深检快照，测量于 ${deepMeasuredAt}。`
    : projectionUsageNotice || "完成 Redis 检测后显示当前派生缓存占用。";
  return (
    <section className={`ready-cache-panel ${healthy ? "ok" : "warn"}`}>
        <div className="ready-cache-panel-head">
          <div>
            <h2>Redis 图片投影</h2>
            <p>核心投影持久化图片读取；派生结果按需生成并带生命周期。</p>
          </div>
          <div className="actions">
            <button
              type="button"
              disabled={busy || query.isFetching}
              onClick={() => void refresh()}
            >
              <AdminIcon name="refresh-line" />
              <StableButtonLabel idle="刷新状态" busyText="刷新中" busy={manualRefreshing} />
            </button>
            {renderMaintenanceAction?.({
              disabled: busy
                || query.isFetching
                || Boolean(status?.rebuilding)
            })}
          </div>
        </div>
        {(maintenanceError || statusError) && (
          <p className="admin-error" role="alert">{maintenanceError || statusError}</p>
        )}
        <dl className="ready-cache-status-grid">
          <div><dt>状态</dt><dd>{status?.rebuilding ? "重建中" : healthy ? "已同步" : status?.reason ?? "读取中"}</dd></div>
          <div>
            <dt>图片数量</dt>
            <dd>{status?.item_count === null || status?.item_count === undefined
              ? "—"
              : status.item_count.toLocaleString()}</dd>
          </div>
          {status?.rebuilding && (
            <div>
              <dt>完整重建进度</dt>
              <dd>{status.processed === null || status.total === null
                ? "—"
                : `${status.processed.toLocaleString()} / ${status.total.toLocaleString()}`}</dd>
            </div>
          )}
          <div><dt>最后更新时间</dt><dd>{formatTime(status?.last_updated_at ?? null)}</dd></div>
          <div><dt>完整重建开始时间</dt><dd>{formatTime(status?.full_rebuild_started_at ?? null)}</dd></div>
          <div><dt>完整重建完成时间</dt><dd>{formatTime(status?.full_rebuild_completed_at ?? null)}</dd></div>
          <div><dt>完整重建耗时</dt><dd>{formatDuration(status?.full_rebuild_duration_ms ?? null)}</dd></div>
          <div>
            <dt>数据库 revision 指纹</dt>
            <dd title={status?.authoritative_revision ? `完整 revision：${status.authoritative_revision}` : undefined}>
              {revisionFingerprint(status?.authoritative_revision)}
            </dd>
          </div>
          <div>
            <dt>Redis revision 指纹</dt>
            <dd title={status?.applied_revision ? `完整 revision：${status.applied_revision}` : undefined}>
              {revisionFingerprint(status?.applied_revision)}
            </dd>
          </div>
        </dl>
        <div
          className="ready-cache-occupancy-grid"
          aria-busy={projectionUsageNotice.startsWith("正在") || undefined}
        >
          <CacheOccupancy
            title="核心投影"
            countLabel="图片成员"
            countUnit="个"
            value={coreOccupancy}
            details={coreDetails}
          />
          <CacheOccupancy
            title="派生缓存"
            countLabel="结果成员"
            countUnit="个"
            value={derivedOccupancy}
            details={derivedDetails}
          />
        </div>
        {(status?.recent_errors.core || status?.recent_errors.derived) && (
          <div className="ready-cache-errors">
            {status.recent_errors.core && (
              <p>最近核心错误（{status.recent_errors.core.code} · {formatTime(status.recent_errors.core.occurred_at)}）：{status.recent_errors.core.message}</p>
            )}
            {status.recent_errors.derived && (
              <p>最近派生错误（{status.recent_errors.derived.code} · {formatTime(status.recent_errors.derived.occurred_at)}）：{status.recent_errors.derived.message}</p>
            )}
          </div>
        )}
    </section>
  );
}

function CacheOccupancy({
  title,
  countLabel,
  countUnit,
  value,
  details
}: {
  title: string;
  countLabel: string;
  countUnit: string;
  value: {
    key_count: number | null;
    count: number | null;
    memory_bytes: number | null;
  } | null;
  details: string;
}) {
  return (
    <section title={details}>
      <h3>{title}</h3>
      <span>{value?.key_count?.toLocaleString() ?? "—"} 个键</span>
      <span>{value?.count?.toLocaleString() ?? "—"} {countUnit}{countLabel}</span>
      <span>{value?.memory_bytes === null || value?.memory_bytes === undefined
        ? "—"
        : formatBytes(value.memory_bytes)}</span>
    </section>
  );
}
