import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ReadyImageCacheAdminStatusDto } from "@imageshow/shared/browser";
import { Icon } from "../../components/icon/Icon.js";
import { StableButtonLabel } from "../../components/data-display/StableButtonLabel.js";
import { api } from "../../lib/api/client.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import {
  readyImageCachePath,
  useReadyImageCacheStatus
} from "../../lib/api/ready-image-cache.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { formatBytes } from "../../lib/ui/formatters.js";

function formatTime(value: string | null) {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

type RebuildErrorBaseline = {
  dataUpdatedAt: number;
  hadStatus: boolean;
  startedAt: string | null;
  builtAt: string | null;
};

export function ReadyImageCachePanel({ canRebuild }: { canRebuild: boolean }) {
  const client = useQueryClient();
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [rebuildStarting, setRebuildStarting] = useState(false);
  const [rebuildError, setRebuildError] = useState("");
  const [rebuildErrorBaseline, setRebuildErrorBaseline] = useState<
    RebuildErrorBaseline | null
  >(null);
  const query = useReadyImageCacheStatus({ enabled: !rebuildStarting });
  const status = query.data;

  useEffect(() => {
    if (!query.error) return;
    reportAdminUiError("cache.ready_images.status", query.error);
  }, [query.error]);

  useEffect(() => {
    if (
      rebuildErrorBaseline !== null
      && query.isSuccess
      && query.dataUpdatedAt > rebuildErrorBaseline.dataUpdatedAt
      && (
        query.data.rebuilding
        || (
          rebuildErrorBaseline.hadStatus
          && (
            query.data.started_at !== rebuildErrorBaseline.startedAt
            || query.data.built_at !== rebuildErrorBaseline.builtAt
          )
        )
      )
    ) {
      setRebuildError("");
      setRebuildErrorBaseline(null);
    }
  }, [query.dataUpdatedAt, query.isSuccess, rebuildErrorBaseline]);

  const refresh = async () => {
    setManualRefreshing(true);
    try {
      const result = await query.refetch();
      if (result.isSuccess) {
        setRebuildError("");
        setRebuildErrorBaseline(null);
      }
    } finally {
      setManualRefreshing(false);
    }
  };

  const rebuild = async () => {
    setRebuildStarting(true);
    try {
      await client.cancelQueries({
        queryKey: queryKeys.readyImageCache,
        exact: true
      });
      const nextStatus = await api<ReadyImageCacheAdminStatusDto>(
        `${readyImageCachePath}/rebuild`,
        { method: "POST" }
      );
      client.setQueryData(queryKeys.readyImageCache, nextStatus);
      await client.invalidateQueries({
        queryKey: queryKeys.overview,
        exact: true,
        refetchType: "none"
      });
      setRebuildError("");
      setRebuildErrorBaseline(null);
    } catch (requestError) {
      reportAdminUiError("cache.ready_images.rebuild", requestError);
      setRebuildError("图片缓存重建未能启动，请检查 Redis 与 PostgreSQL 状态。");
      setRebuildErrorBaseline({
        dataUpdatedAt: query.dataUpdatedAt,
        hadStatus: status !== undefined,
        startedAt: status?.started_at ?? null,
        builtAt: status?.built_at ?? null
      });
    } finally {
      setRebuildStarting(false);
    }
  };

  const healthy = Boolean(status?.synchronized && !status.rebuilding);
  const statusError = query.isError
    ? "无法读取图片缓存状态，请稍后重试。"
    : "";
  const busy = manualRefreshing || rebuildStarting;
  return (
    <section className={`ready-cache-panel ${healthy ? "ok" : "warn"}`}>
      <div className="ready-cache-panel-head">
        <div>
          <h2>图片缓存</h2>
          <p>画廊、公开详情、随机图和后台就绪图片列表共用的 Redis 读模型。</p>
        </div>
        <div className="actions">
          <button
            type="button"
            disabled={busy || query.isFetching}
            onClick={() => void refresh()}
          >
            <Icon name="refresh-line" />
            <StableButtonLabel idle="刷新状态" busyText="刷新中" busy={manualRefreshing} />
          </button>
          {canRebuild && (
            <button
              type="button"
              disabled={busy || query.isFetching || Boolean(status?.rebuilding)}
              onClick={() => void rebuild()}
            >
              <Icon name="database-2-line" />
              <StableButtonLabel idle="重建图片缓存" busyText="启动中" busy={rebuildStarting} />
            </button>
          )}
        </div>
      </div>
      {(rebuildError || statusError) && (
        <p className="error" role="alert">{rebuildError || statusError}</p>
      )}
      <dl className="ready-cache-status-grid">
        <div><dt>状态</dt><dd>{status?.rebuilding ? "重建中" : healthy ? "已同步" : status?.reason ?? "读取中"}</dd></div>
        <div><dt>图片数量</dt><dd>{status?.item_count?.toLocaleString() ?? "—"}</dd></div>
        <div><dt>投影大小</dt><dd>{status?.memory_bytes === null || status?.memory_bytes === undefined ? "—" : formatBytes(status.memory_bytes)}</dd></div>
        <div><dt>构建进度</dt><dd>{status?.total === null || status?.total === undefined ? "—" : `${status.processed ?? 0} / ${status.total}`}</dd></div>
        <div><dt>数据库 revision</dt><dd title={status?.authoritative_revision}>{status?.authoritative_revision ?? "—"}</dd></div>
        <div><dt>Redis revision</dt><dd title={status?.applied_revision ?? ""}>{status?.applied_revision ?? "—"}</dd></div>
        <div><dt>开始时间</dt><dd>{formatTime(status?.started_at ?? null)}</dd></div>
        <div><dt>完成时间</dt><dd>{formatTime(status?.built_at ?? null)}</dd></div>
      </dl>
      {status?.last_error && <p className="ready-cache-error">最近错误：{status.last_error}</p>}
    </section>
  );
}
