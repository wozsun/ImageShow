import { useEffect, useRef, useState } from "react";
import {
  useQueryClient,
  type UseQueryResult
} from "@tanstack/react-query";
import type {
  AdminCheckStatusDto,
  ReadyImageCacheAdminStatusDto
} from "@imageshow/shared/browser";
import { Icon } from "../../components/icon/Icon.js";
import { StableButtonLabel } from "../../components/data-display/StableButtonLabel.js";
import { DialogFrame } from "../../components/feedback/DialogFrame.js";
import { api } from "../../lib/api/client.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import {
  readyImageCacheRebuildPath,
  readyImageProjection
} from "../../lib/api/ready-image-cache.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import {
  formatBytes,
  revisionFingerprint
} from "../../lib/ui/formatters.js";

function formatTime(value: string | null) {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

function formatDuration(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function stageLabel(stage: ReadyImageCacheAdminStatusDto["stage"] | undefined) {
  if (!stage) return "—";
  if (stage === "rebuilding_core") return "重建核心投影";
  if (stage === "validating") return "校验中";
  if (stage === "degraded") return "已降级";
  return "空闲";
}

type RebuildErrorBaseline = {
  dataUpdatedAt: number;
  hadStatus: boolean;
  startedAt: string | null;
  builtAt: string | null;
};

export function ReadyImageCachePanel({
  canRebuild,
  query
}: {
  canRebuild: boolean;
  query: UseQueryResult<AdminCheckStatusDto, Error>;
}) {
  const client = useQueryClient();
  const rebuildRequestActive = useRef(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [rebuildStarting, setRebuildStarting] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [rebuildError, setRebuildError] = useState("");
  const [rebuildErrorBaseline, setRebuildErrorBaseline] = useState<
    RebuildErrorBaseline | null
  >(null);
  const status = readyImageProjection(query.data);

  useEffect(() => {
    if (!query.error) return;
    reportAdminUiError("check.status", query.error);
  }, [query.error]);

  useEffect(() => {
    const current = readyImageProjection(query.data);
    if (
      rebuildErrorBaseline !== null
      && query.isSuccess
      && current
      && query.dataUpdatedAt > rebuildErrorBaseline.dataUpdatedAt
      && (
        current.rebuilding
        || (
          rebuildErrorBaseline.hadStatus
          && (
            current.started_at !== rebuildErrorBaseline.startedAt
            || current.built_at !== rebuildErrorBaseline.builtAt
          )
        )
      )
    ) {
      setRebuildError("");
      setRebuildErrorBaseline(null);
    }
  }, [query.data, query.dataUpdatedAt, query.isSuccess, rebuildErrorBaseline]);

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
    if (rebuildRequestActive.current) return;
    rebuildRequestActive.current = true;
    setConfirmRebuild(false);
    setRebuildStarting(true);
    try {
      await client.cancelQueries({
        queryKey: queryKeys.adminCheckStatus,
        exact: true
      });
      const nextStatus = await api<AdminCheckStatusDto>(
        readyImageCacheRebuildPath,
        { method: "POST" }
      );
      client.setQueryData(queryKeys.adminCheckStatus, nextStatus);
      await client.invalidateQueries({
        queryKey: queryKeys.overview,
        exact: true,
        refetchType: "none"
      });
      setRebuildError("");
      setRebuildErrorBaseline(null);
    } catch (requestError) {
      reportAdminUiError("cache.ready_images.rebuild", requestError);
      setRebuildError("图片投影重建未能启动，请检查 Redis 与 PostgreSQL 状态。");
      setRebuildErrorBaseline({
        dataUpdatedAt: query.dataUpdatedAt,
        hadStatus: status !== undefined,
        startedAt: status?.started_at ?? null,
        builtAt: status?.built_at ?? null
      });
    } finally {
      rebuildRequestActive.current = false;
      setRebuildStarting(false);
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
  const busy = manualRefreshing || rebuildStarting;
  return (
    <>
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
              <Icon name="refresh-line" />
              <StableButtonLabel idle="刷新状态" busyText="刷新中" busy={manualRefreshing} />
            </button>
            {canRebuild && (
              <button
                type="button"
                disabled={busy || query.isFetching || Boolean(status?.rebuilding)}
                onClick={() => setConfirmRebuild(true)}
              >
                <Icon name="database-2-line" />
                <StableButtonLabel idle="重建图片投影" busyText="启动中" busy={rebuildStarting} />
              </button>
            )}
          </div>
        </div>
        {(rebuildError || statusError) && (
          <p className="error" role="alert">{rebuildError || statusError}</p>
        )}
        <dl className="ready-cache-status-grid">
          <div><dt>状态</dt><dd>{status?.rebuilding ? "重建中" : healthy ? "已同步" : status?.reason ?? "读取中"}</dd></div>
          <div><dt>阶段</dt><dd>{stageLabel(status?.stage)}</dd></div>
          <div><dt>图片数量</dt><dd>{status?.item_count?.toLocaleString() ?? "—"}</dd></div>
          <div><dt>构建进度</dt><dd>{status?.total === null || status?.total === undefined ? "—" : `${status.processed ?? 0} / ${status.total}`}</dd></div>
          <div>
            <dt>本次耗时</dt>
            <dd>{!status?.rebuilding && status?.built_at ? formatDuration(status.elapsed_ms) : "—"}</dd>
          </div>
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
          <div>
            <dt title="核心投影或派生缓存最近一次内容变更时间">最后更新时间</dt>
            <dd>{formatTime(status?.last_updated_at ?? null)}</dd>
          </div>
          <div><dt>完整重建开始时间</dt><dd>{formatTime(status?.started_at ?? null)}</dd></div>
          <div><dt>完整重建完成时间</dt><dd>{formatTime(status?.built_at ?? null)}</dd></div>
        </dl>
        <div className="ready-cache-occupancy-grid">
          <CacheOccupancy
            title="核心投影"
            memberLabel="图片成员"
            value={status?.core}
          />
          <CacheOccupancy
            title="派生缓存"
            memberLabel="结果成员"
            value={status?.derived}
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
      {confirmRebuild && canRebuild && (
        <RebuildConfirmation
          busy={rebuildStarting}
          onClose={() => setConfirmRebuild(false)}
          onConfirm={rebuild}
        />
      )}
    </>
  );
}

function CacheOccupancy({ title, memberLabel, value }: {
  title: string;
  memberLabel: string;
  value: ReadyImageCacheAdminStatusDto["core"] | undefined;
}) {
  return (
    <section>
      <h3>{title}</h3>
      <span>{value?.key_count?.toLocaleString() ?? "—"} 个键</span>
      <span>{value?.member_count?.toLocaleString() ?? "—"} 个{memberLabel}</span>
      <span>{value?.memory_bytes === null || value?.memory_bytes === undefined ? "—" : formatBytes(value.memory_bytes)}</span>
    </section>
  );
}

function RebuildConfirmation({ busy, onClose, onConfirm }: {
  busy: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const title = "重建 Redis 图片投影";
  return (
    <DialogFrame
      className="modal edit-modal"
      ariaLabel={title}
      busy={busy}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <form
          className="operation-modal"
          onSubmit={(event) => {
            event.preventDefault();
            void onConfirm();
          }}
        >
          <header>
            <div>
              <h2>{title}</h2>
              <p>关闭缓存读门，分批从 PostgreSQL 重建核心图片投影。</p>
            </div>
            <button
              className="icon close pressable"
              type="button"
              title="关闭"
              disabled={busy}
              onClick={() => requestClose()}
            >
              <Icon name="close-line" />
            </button>
          </header>
          <div className="operation-body">
            <p className="notice-line">只清理 ImageShow 自有的核心与派生图片键；不会修改 PostgreSQL 图片、管理员会话、限流数据或随机历史。</p>
          </div>
          <footer>
            <button type="button" disabled={busy} onClick={() => requestClose()}>取消</button>
            <button className="button" type="submit" disabled={busy}>
              <Icon name="database-2-line" />
              <StableButtonLabel idle="确认重建" busyText="启动中" busy={busy} />
            </button>
          </footer>
        </form>
      )}
    </DialogFrame>
  );
}
