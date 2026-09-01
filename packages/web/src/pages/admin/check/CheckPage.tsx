import { lazy, Suspense, useEffect, useState } from "react";
import {
  adminPermissions,
  type AdminCheckStatusDto
} from "@imageshow/shared/browser";
import type { UseQueryResult } from "@tanstack/react-query";
import { api } from "../../../lib/api/client.js";
import { adminApiBasePath } from "../../../lib/constants.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { StableButtonLabel } from "../../../components/data-display/StableButtonLabel.js";
import { useAdminPermissions } from "../../../hooks/useAuthSession.js";
import {
  readyImageProjection,
  useAdminCheckStatus
} from "../../../lib/api/ready-image-cache.js";
import {
  readyImageProjectionUsage,
  useAdminRedisInspection,
  useRetainedReadyImageProjectionUsage
} from "./check-redis-inspection.js";
import {
  createPageLifetimeModuleLoader
} from "../../../lib/page-lifetime-module-loader.js";
import {
  formatBytes,
  revisionFingerprint
} from "../../../lib/ui/formatters.js";
import { ReadyImageCachePanel } from "./ReadyImageCachePanel.js";
import "../../../styles/admin/check.css";

const loadCheckMaintenanceCapability = createPageLifetimeModuleLoader(
  () => import("./CheckMaintenanceCapability.js")
);
const CheckStorageMaintenanceActions = lazy(() => (
  loadCheckMaintenanceCapability().then((module) => ({
    default: module.CheckStorageMaintenanceActions
  }))
));
const TrashPurgeMaintenanceActions = lazy(() => (
  loadCheckMaintenanceCapability().then((module) => ({
    default: module.TrashPurgeMaintenanceActions
  }))
));
const ReadyImageCacheMaintenancePanel = lazy(() => (
  loadCheckMaintenanceCapability().then((module) => ({
    default: module.ReadyImageCacheMaintenancePanel
  }))
));

const checkViews = [
  { name: "status", label: "状态" },
  { name: "db", label: "数据库" },
  { name: "trash", label: "回收站" },
  { name: "storage", label: "存储" },
  { name: "redis", label: "Redis" },
  { name: "all", label: "全部" }
] as const;

type CheckView = typeof checkViews[number]["name"];

export function CheckPage() {
  const [result, setResult] = useState<unknown>(null);
  const [resultKind, setResultKind] = useState("");
  const [running, setRunning] = useState("");
  const [automaticInspectionSatisfied, setAutomaticInspectionSatisfied] =
    useState(false);
  const [checkView, setCheckView] = useState<CheckView>("status");
  const permissions = useAdminPermissions();
  const statusQuery = useAdminCheckStatus();
  const projectionStatus = readyImageProjection(statusQuery.data);
  const automaticInspectionEligible = statusQuery.isSuccess
    && statusQuery.data.redis.status === "ok"
    && projectionStatus?.rebuilding !== true;
  const redisInspectionQuery = useAdminRedisInspection({
    enabled: automaticInspectionEligible
      && !automaticInspectionSatisfied
      && running !== "all"
  });
  const {
    currentProjectionUsage: automaticProjectionUsage,
    projectionUsage,
    retainProjectionUsage
  } = useRetainedReadyImageProjectionUsage(redisInspectionQuery.data);
  const projectionUsageNotice = projectionStatus?.rebuilding
    ? "图片投影重建中，完成后会自动重新检测占用。"
    : redisInspectionQuery.isFetching
      ? projectionUsage
        ? "正在后台更新当前 Redis 占用。"
        : "正在后台自动检测当前 Redis 占用。"
      : redisInspectionQuery.isError
        ? projectionUsage
          ? "自动检测失败，继续显示最近一次完整快照；请点击 Redis 重试。"
          : "自动检测失败，请点击 Redis 重试。"
        : redisInspectionQuery.data !== undefined
          && !automaticProjectionUsage
          && !automaticInspectionSatisfied
          ? projectionUsage
            ? "本次检测未完成，继续显示最近一次完整快照。"
            : "检测未完成，部分结果未采用；请点击 Redis 查看明细。"
          : "";
  const redisInclusiveCheckBlocked = statusQuery.isPending
    || projectionStatus?.rebuilding === true
    || redisInspectionQuery.isFetching;
  const canMigrateStorage = permissions.includes(
    adminPermissions.storageMaintenanceMigrate
  );
  const canMaintainStorage = permissions.includes(
    adminPermissions.storageMaintenanceExecute
  );
  const canRebuildCache = permissions.includes(
    adminPermissions.cacheMaintenanceRebuild
  );
  const canMaintainTrashPurge = permissions.includes(
    adminPermissions.imageTrashPurge
  );

  useEffect(() => {
    if (!redisInspectionQuery.error) return;
    reportAdminUiError(
      "check.redis.inspection",
      redisInspectionQuery.error
    );
  }, [redisInspectionQuery.error]);

  useEffect(() => {
    if (projectionStatus?.rebuilding) {
      setAutomaticInspectionSatisfied(false);
    }
  }, [projectionStatus?.rebuilding]);

  const runCheck = async (name: string, body?: Record<string, unknown>) => {
    let allInspectionSatisfied = false;
    if (name === "all") setAutomaticInspectionSatisfied(true);
    setRunning(name);
    try {
      const value = name === "redis"
        ? await refetchRedisInspection(redisInspectionQuery)
        : await api(`${adminApiBasePath}/check/${name}`, {
          method: "POST",
          body: body ? JSON.stringify(body) : undefined
        });
      setResult(value);
      setResultKind(name);
      if (name === "redis") {
        if (retainProjectionUsage(readyImageProjectionUsage(value, "redis"))) {
          setAutomaticInspectionSatisfied(true);
        }
      } else if (name === "all") {
        allInspectionSatisfied = Boolean(retainProjectionUsage(
          readyImageProjectionUsage(value, "all")
        ));
      }
      return value;
    } catch (error) {
      if (name !== "redis") reportAdminUiError(`check.${name}`, error);
      setResult({ ok: false, error: "检查执行失败，请稍后重试" });
      setResultKind(name);
      return null;
    } finally {
      if (name === "all") {
        setAutomaticInspectionSatisfied(allInspectionSatisfied);
      }
      setRunning("");
    }
  };
  const selectCheckView = (view: CheckView) => {
    setCheckView(view);
    setResult(null);
    setResultKind("");
    if (view !== "status") void runCheck(view);
  };
  return (
    <section className="workspace">
      <header className="workspace-head">
        <div><h1>检查</h1><p>检查数据库、Redis 与存储一致性</p></div>
        <div className="check-actions">
          <div className="actions">
            {checkViews.map((check) => (
              <button
                type="button"
                key={check.name}
                className={checkView === check.name ? "active" : undefined}
                aria-pressed={checkView === check.name}
                disabled={Boolean(running) || (
                  redisInclusiveCheckBlocked
                  && (check.name === "redis" || check.name === "all")
                )}
                onClick={() => selectCheckView(check.name)}
              >
                <AdminIcon name={check.name === "status" ? "dashboard-line" : "refresh-line"} /><StableButtonLabel idle={check.label} busyText="运行中" busy={running === check.name} />
              </button>
            ))}
          </div>
          {(canMigrateStorage || canMaintainStorage) && (
            <Suspense fallback={null}>
              <CheckStorageMaintenanceActions
                canMaintainStorage={canMaintainStorage}
                canMigrateStorage={canMigrateStorage}
                result={result}
                resultKind={resultKind}
                running={running}
                onPublishResult={(value, kind) => {
                  setResult(value);
                  setResultKind(kind);
                }}
                onRunCheck={runCheck}
                onRunningChange={setRunning}
                onShowStorage={() => setCheckView("storage")}
              />
            </Suspense>
          )}
          {canMaintainTrashPurge && (
            <Suspense fallback={null}>
              <TrashPurgeMaintenanceActions
                running={running}
                onRunCheck={runCheck}
                onShowTrash={() => setCheckView("trash")}
              />
            </Suspense>
          )}
        </div>
      </header>
      {(checkView === "status" || checkView === "all") && (
        <>
          <LightweightStatusCards query={statusQuery} />
          {canRebuildCache
            ? (
              <Suspense fallback={(
                <ReadyImageCachePanel
                  query={statusQuery}
                  projectionUsage={projectionUsage}
                  projectionUsageNotice={projectionUsageNotice}
                  reportQueryError={false}
                />
              )}>
                <ReadyImageCacheMaintenancePanel
                  query={statusQuery}
                  projectionUsage={projectionUsage}
                  projectionUsageNotice={projectionUsageNotice}
                />
              </Suspense>
            )
            : (
              <ReadyImageCachePanel
                query={statusQuery}
                projectionUsage={projectionUsage}
                projectionUsageNotice={projectionUsageNotice}
              />
            )}
        </>
      )}
      {result !== null && <CheckResult result={result} />}
    </section>
  );
}

async function refetchRedisInspection(
  query: ReturnType<typeof useAdminRedisInspection>
) {
  const result = await query.refetch({ cancelRefetch: false });
  if (result.isError) throw result.error;
  if (result.data === undefined) {
    throw new Error("Redis inspection returned no result");
  }
  return result.data;
}

function LightweightStatusCards({ query }: {
  query: UseQueryResult<AdminCheckStatusDto, Error>;
}) {
  const postgresql = query.data?.postgresql;
  const redis = query.data?.redis;
  const requestError = query.isError ? "轻量状态请求失败，请手动刷新重试。" : "";
  return (
    <div className="check-status-grid">
      <section className={`check-status-card ${postgresql?.status === "ok"
          ? "ok"
          : postgresql?.status === "error" || requestError
            ? "warn"
            : ""
        }`}>
        <header>
          <div><h2>PostgreSQL</h2><p>权威图片与后台任务真相源</p></div>
          <span>{postgresql?.status === "ok" ? "已连接" : postgresql?.status === "error" ? "异常" : "读取中"}</span>
        </header>
        {requestError && <p className="admin-error" role="alert">{requestError}</p>}
        {postgresql?.status === "error" && (
          <p className="admin-error" role="alert">{postgresql.error.category} · {postgresql.error.code} · {postgresql.error.message}</p>
        )}
        <dl>
          <div>
            <dt>版本</dt>
            <dd title={postgresql?.status === "ok" ? postgresql.data.version : undefined}>
              {postgresql?.status === "ok" ? postgresql.data.version : "—"}
            </dd>
          </div>
          <div><dt>响应耗时</dt><dd>{postgresql?.status === "ok" ? `${postgresql.data.latency_ms} ms` : "—"}</dd></div>
          <div><dt>ready / 总图片</dt><dd>{postgresql?.status === "ok" ? `${postgresql.data.ready_images.toLocaleString()} / ${postgresql.data.total_images.toLocaleString()}` : "—"}</dd></div>
          <div>
            <dt>权威 revision 指纹</dt>
            <dd title={postgresql?.status === "ok" ? `完整 revision：${postgresql.data.authoritative_revision}` : undefined}>
              {revisionFingerprint(postgresql?.status === "ok" ? postgresql.data.authoritative_revision : null)}
            </dd>
          </div>
          <div><dt>异常后台任务</dt><dd>{postgresql?.status === "ok" ? postgresql.data.abnormal_jobs.toLocaleString() : "—"}</dd></div>
        </dl>
      </section>
      <section className={`check-status-card ${redis?.status === "ok"
          ? "ok"
          : redis?.status === "error" || requestError
            ? "warn"
            : ""
        }`}>
        <header>
          <div><h2>Redis</h2><p>缓存、会话与安全运行时依赖</p></div>
          <span>{redis?.status === "ok" ? "已连接" : redis?.status === "error" ? "异常" : "读取中"}</span>
        </header>
        {requestError && <p className="admin-error" role="alert">{requestError}</p>}
        {redis?.status === "error" && (
          <p className="admin-error" role="alert">{redis.error.category} · {redis.error.code} · {redis.error.message}</p>
        )}
        <dl>
          <div><dt>版本 / DB</dt><dd>{redis?.status === "ok" ? `${redis.data.version} / ${redis.data.configured_db}` : "—"}</dd></div>
          <div><dt>响应耗时</dt><dd>{redis?.status === "ok" ? `${redis.data.latency_ms} ms` : "—"}</dd></div>
          <div><dt>全局碎片率</dt><dd>{redis?.status === "ok" ? redis.data.memory.fragmentation_ratio ?? "—" : "—"}</dd></div>
          <div>
            <dt title="Redis 分配器已分配的总内存（INFO MEMORY: used_memory）">全局 used</dt>
            <dd>{redis?.status === "ok" ? formatStatusBytes(redis.data.memory.used_memory_bytes) : "—"}</dd>
          </div>
          <div>
            <dt title="操作系统观测到的 Redis 常驻内存（INFO MEMORY: used_memory_rss）">全局 RSS</dt>
            <dd>{redis?.status === "ok" ? formatStatusBytes(redis.data.memory.used_memory_rss_bytes) : "—"}</dd>
          </div>
        </dl>
        <p className="check-status-note">内存字段来自 INFO MEMORY，仅表示整个 Redis 实例的观测值。</p>
      </section>
    </div>
  );
}

function formatStatusBytes(value: number | null) {
  return value === null ? "—" : formatBytes(value);
}

function CheckResult({ result }: { result: unknown }) {
  const objectResult = result && typeof result === "object" ? result as Record<string, unknown> : { value: result };
  const entries = Object.entries(objectResult).filter(([key]) => key !== "ok");
  const totalIssues = countCheckIssues(objectResult);
  const maintenanceSummary = storageMaintenanceSummary(objectResult);
  return (
    <>
      <div className={`check-summary ${maintenanceSummary?.warning || totalIssues ? "warn" : "ok"}`}>
        <strong>{maintenanceSummary?.title ?? (totalIssues ? `发现 ${totalIssues} 项需要处理` : "检查结果正常")}</strong>
        <span>{maintenanceSummary?.detail ?? "下方卡片展示每项检查的摘要，展开 JSON 可查看原始明细。"}</span>
      </div>
      <div className="check-result">
        {entries.map(([key, value]) => {
          const issue = countCheckIssues({ [key]: value });
          return (
            <section key={key} className={issue ? "check-card warn" : "check-card ok"}>
              <div className="check-card-head">
                <h2 title={key}>{checkResultLabel(key)}</h2>
                <span>{issue ? `${issue} 项` : "正常"}</span>
              </div>
              <pre>{JSON.stringify(value, null, 2)}</pre>
            </section>
          );
        })}
      </div>
    </>
  );
}

const CHECK_RESULT_LABELS: Record<string, string> = {
  database: "数据库深度检查",
  redis: "Redis 深度检查",
  status: "轻量状态",
  data: "检查结果",
  // 数据库检查
  operations: "进行中 / 失败的任务",
  public_pg_fallback: "公开 PostgreSQL 回源准入",
  // 回收站
  deleted_count: "回收站数量",
  unqueued_count: "未排队数量",
  purge_pending_count: "待彻底删除数量",
  job_counts: "彻底删除任务状态",
  jobs: "彻底删除任务",
  candidates: "待处理对象",
  // 存储检查
  missing_objects: "缺失的原图",
  missing_thumbs: "缺失的缩略图",
  pending_thumbnail_repairs: "待重新确认的缩略图",
  orphan_objects: "游离的原图",
  orphan_thumbs: "游离的缩略图",
  active_staging_files: "有效的内容接入暂存文件",
  retained_staging_files: "由内容接入会话保留的暂存文件",
  orphan_staging_files: "失效的内容接入暂存文件",
  stale_ingestion_raw_files: "陈旧的内容接入 raw 文件",
  stale_ingestion_part_files: "陈旧的内容接入 .part 文件",
  incomplete_ingestion_raw_scan: "未完整扫描的内容接入临时目录",
  incomplete_listings: "未完整列举的存储命名空间",
  unavailable_backends: "无法访问的后端",
  // 存储维护
  requested: "维护请求项",
  repaired: "已修复缩略图",
  removed: "已删除对象",
  skipped: "已安全跳过",
  failed: "维护失败数量",
  active_staging_objects_retained: "已保留有效内容接入暂存",
  pruned_dirs: "已回收空目录",
  items: "逐项维护明细",
  failures: "失败项",
  migrated: "已迁移",
  unchanged: "无需迁移",
  missing: "源对象缺失",
  media: "原图数",
  thumbs: "缩略图数",
  error_samples: "错误样本",
  error_count: "错误数量",
  // 迁移存储后端
  migration: "迁移结果",
  // Redis 状态
  connection: "连接状态",
  deep_inspection: "当前键空间深检",
  prefix_counts: "键数量统计",
  image_projection: "Redis 图片投影",
  core: "核心投影",
  derived: "派生缓存",
  recent_errors: "最近投影错误",
  ready_count: "图库就绪数",
  ready_cache_count: "缓存就绪数",
  ready_cache_readable: "缓存可读",
  ready_cache_state: "缓存状态",
  ready_cache_mismatch: "缓存数量不一致",
  issues: "发现的问题",
  // 全部检查（概览）
  images: "图片总数",
  default_backend: "默认存储后端",
  storage: "存储深度检查",
  trash: "回收站深度检查",
};

function checkResultLabel(key: string) {
  return CHECK_RESULT_LABELS[key] ?? key;
}

function isIssueKey(key: string) {
  return [
    "issues", "operations", "failures", "failed", "unavailable_backends", "incomplete_listings", "error", "error_count",
    "missing_objects", "missing_thumbs", "pending_thumbnail_repairs",
    "orphan_objects", "orphan_thumbs", "orphan_staging_files",
    "stale_ingestion_raw_files", "stale_ingestion_part_files",
    "incomplete_ingestion_raw_scan", "ready_cache_mismatch"
  ].includes(key);
}

function storageMaintenanceSummary(result: Record<string, unknown>) {
  if (!("requested" in result) || !("repaired" in result) || !("items" in result)) {
    return null;
  }
  const requested = numericResult(result.requested);
  const repaired = numericResult(result.repaired);
  const removed = numericResult(result.removed);
  const skipped = numericResult(result.skipped);
  const failed = numericResult(result.failed);
  const prunedDirs = numericResult(result.pruned_dirs);
  return {
    warning: failed > 0,
    title: failed
      ? `存储维护完成，但有 ${failed} 项失败`
      : `存储维护完成：修复 ${repaired} 项，删除 ${removed} 项`,
    detail: failed
      ? `本次共请求 ${requested} 项；失败项未被视为成功，请根据逐项明细处理后安全重试。`
      : `本次共请求 ${requested} 项，安全跳过 ${skipped} 项，另回收 ${prunedDirs} 个空目录。`
  };
}

function numericResult(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function countCheckIssues(result: Record<string, unknown>) {
  let total = 0;
  for (const [key, value] of Object.entries(result)) {
    if (key === "ok") continue;
    if (isIssueKey(key)) {
      if (
        (key === "stale_ingestion_raw_files" || key === "stale_ingestion_part_files")
        && value
        && typeof value === "object"
      ) {
        total += numericResult((value as Record<string, unknown>).count);
      } else {
        total += countValue(value);
      }
    } else if (value && typeof value === "object") {
      total += countCheckIssues(value as Record<string, unknown>);
    }
  }
  if (total) return total;
  return result.ok === false ? 1 : 0;
}

function countValue(value: unknown) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return typeof value === "number" ? value : value ? 1 : 0;
}
