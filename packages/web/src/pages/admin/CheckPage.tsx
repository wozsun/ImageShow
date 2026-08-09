import { useState } from "react";
import {
  adminPermissions,
  type AdminCheckStatusDto
} from "@imageshow/shared/browser";
import type { UseQueryResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api/client.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { AdminIcon } from "../../components/icon/AdminIcon.js";
import { DialogFrame } from "../../components/feedback/DialogFrame.js";
import { StableButtonLabel } from "../../components/data-display/StableButtonLabel.js";
import { migrateStorageBackend } from "../../lib/api/storage-backend-migration.js";
import { invalidateStorageData } from "../../lib/api/query-invalidation.js";
import { useAdminPermissions } from "../../hooks/useAuthSession.js";
import { useAdminCheckStatus } from "../../lib/api/ready-image-cache.js";
import {
  formatBytes,
  revisionFingerprint
} from "../../lib/ui/formatters.js";
import { StorageBackendMigrationDialog } from "./storage/StorageBackendMigrationDialog.js";
import { ReadyImageCachePanel } from "./ReadyImageCachePanel.js";
import "../../styles/admin/check.css";

const checkViews = [
  { name: "status", label: "状态" },
  { name: "db", label: "数据库" },
  { name: "storage", label: "存储" },
  { name: "redis", label: "Redis" },
  { name: "trash", label: "回收站" },
  { name: "all", label: "全部" }
] as const;

type CheckView = typeof checkViews[number]["name"];

export function CheckPage() {
  const client = useQueryClient();
  const [result, setResult] = useState<unknown>(null);
  const [running, setRunning] = useState("");
  const [checkView, setCheckView] = useState<CheckView>("status");
  const permissions = useAdminPermissions();
  const statusQuery = useAdminCheckStatus();
  const canMigrateStorage = permissions.includes(
    adminPermissions.storageMaintenanceMigrate
  );
  const canCleanupStorage = permissions.includes(
    adminPermissions.storageMaintenanceCleanup
  );
  const canRebuildCache = permissions.includes(
    adminPermissions.cacheMaintenanceRebuild
  );
  const [operationModal, setOperationModal] = useState<
    "storage-backend-migration" | "storage-cleanup" | null
  >(null);
  const runCheck = async (name: string, body?: Record<string, unknown>) => {
    setRunning(name);
    try {
      setResult(await api(`${adminApiBasePath}/check/${name}`, { method: "POST", body: body ? JSON.stringify(body) : undefined }));
      return true;
    } catch (error) {
      reportAdminUiError(`check.${name}`, error);
      setResult({ ok: false, error: "检查执行失败，请稍后重试" });
      return false;
    } finally {
      setRunning("");
    }
  };
  const selectCheckView = (view: CheckView) => {
    setCheckView(view);
    setResult(null);
    if (view !== "status") void runCheck(view);
  };
  const runStorageMigration = async (source: string, target: string) => {
    setRunning("storage-backend-migration");
    try {
      setResult(await migrateStorageBackend(source, target));
      return true;
    } catch (error) {
      reportAdminUiError("storage.backend_migration", error);
      setResult({ ok: false, error: "迁移执行失败，请检查存储配置后重试" });
      return false;
    } finally {
      await invalidateStorageData(client).catch((error) => {
        reportAdminUiError("storage.backend_migration.refresh", error);
      });
      setRunning("");
    }
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
                disabled={Boolean(running)}
                onClick={() => selectCheckView(check.name)}
              >
                <AdminIcon name={check.name === "status" ? "dashboard-line" : "refresh-line"} /><StableButtonLabel idle={check.label} busyText="运行中" busy={running === check.name} />
              </button>
            ))}
          </div>
          {(canMigrateStorage || canCleanupStorage) && (
            <div className="actions">
              {canMigrateStorage && (
                <button
                  type="button"
                  disabled={Boolean(running)}
                  onClick={() => setOperationModal("storage-backend-migration")}
                >
                  <AdminIcon name="database-2-line" /><StableButtonLabel idle="迁移存储后端" busyText="迁移中" busy={running === "storage-backend-migration"} />
                </button>
              )}
              {canCleanupStorage && (
                <button
                  className="danger-button"
                  type="button"
                  disabled={Boolean(running)}
                  onClick={() => setOperationModal("storage-cleanup")}
                >
                  <AdminIcon name="delete-bin-6-line" /><StableButtonLabel idle="清理无效存储" busyText="清理中" busy={running === "storage-cleanup"} />
                </button>
              )}
            </div>
          )}
        </div>
      </header>
      {(checkView === "status" || checkView === "all") && (
        <>
          <LightweightStatusCards query={statusQuery} />
          <ReadyImageCachePanel canRebuild={canRebuildCache} query={statusQuery} />
        </>
      )}
      {operationModal === "storage-backend-migration" && canMigrateStorage && (
        <StorageBackendMigrationDialog
          busy={Boolean(running)}
          onClose={() => setOperationModal(null)}
          onRun={runStorageMigration}
        />
      )}
      {operationModal === "storage-cleanup" && canCleanupStorage && (
        <StorageCleanupDialog
          running={running}
          onClose={() => setOperationModal(null)}
          onRun={() => runCheck("storage-cleanup")}
        />
      )}
      {result !== null && <CheckResult result={result} />}
    </section>
  );
}

function LightweightStatusCards({ query }: {
  query: UseQueryResult<AdminCheckStatusDto, Error>;
}) {
  const postgresql = query.data?.postgresql;
  const redis = query.data?.redis;
  const requestError = query.isError ? "轻量状态请求失败，请手动刷新重试。" : "";
  return (
    <div className="check-status-grid">
      <section className={`check-status-card ${
        postgresql?.status === "ok"
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
      <section className={`check-status-card ${
        redis?.status === "ok"
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

function StorageCleanupDialog({ running, onClose, onRun }: {
  running: string;
  onClose: () => void;
  onRun: () => Promise<boolean>;
}) {
  const [errorMessage, setErrorMessage] = useState("");
  const title = "清理无效存储";
  const description = "删除数据库未引用的原图、缩略图及已失效的上传暂存文件。回收站中的图片文件和其他仍被引用的对象会保留。";
  return (
    <DialogFrame
      className="modal edit-modal"
      ariaLabel={title}
      busy={Boolean(running)}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <form
          className="operation-modal"
          onSubmit={async (event) => {
            event.preventDefault();
            setErrorMessage("");
            if (await onRun()) {
              requestClose();
            } else {
              setErrorMessage("清理执行失败，请稍后重试。");
            }
          }}
        >
          <header>
            <div>
              <h2>{title}</h2>
              <p>{description}</p>
            </div>
            <button
              className="icon close pressable"
              type="button"
              title="关闭"
              disabled={Boolean(running)}
              onClick={() => requestClose()}
            >
              <AdminIcon name="close-line" />
            </button>
          </header>
          <div className="operation-body">
            <p className="notice-line">此操作会修改存储对象。执行前请先运行存储检查，确认检查结果，并避免同时上传或批量编辑图片。</p>
            {errorMessage && (
              <p className="admin-error" role="alert">{errorMessage}</p>
            )}
          </div>
          <footer>
            <button type="button" disabled={Boolean(running)} onClick={() => requestClose()}>取消</button>
            <button
              className="button"
              type="submit"
              disabled={Boolean(running)}
            >
              <AdminIcon name="refresh-line" /><StableButtonLabel idle="开始执行" busyText="清理中" busy={running === "storage-cleanup"} />
            </button>
          </footer>
        </form>
      )}
    </DialogFrame>
  );
}

function CheckResult({ result }: { result: unknown }) {
  const objectResult = result && typeof result === "object" ? result as Record<string, unknown> : { value: result };
  const entries = Object.entries(objectResult).filter(([key]) => key !== "ok");
  const totalIssues = countCheckIssues(objectResult);
  const cleanupSummary = storageCleanupSummary(objectResult);
  return (
    <>
      <div className={`check-summary ${cleanupSummary?.warning || totalIssues ? "warn" : "ok"}`}>
        <strong>{cleanupSummary?.title ?? (totalIssues ? `发现 ${totalIssues} 项需要处理` : "检查结果正常")}</strong>
        <span>{cleanupSummary?.detail ?? "下方卡片展示每项检查的摘要，展开 JSON 可查看原始明细。"}</span>
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
  candidates: "待处理对象",
  // 存储检查
  missing_objects: "缺失的原图",
  missing_thumbs: "缺失的缩略图",
  orphan_objects: "游离的原图",
  orphan_thumbs: "游离的缩略图",
  active_staging_files: "有效的导入暂存文件",
  orphan_staging_files: "失效的导入暂存文件",
  unavailable_backends: "无法访问的后端",
  // 清理无效存储
  removed: "已删除对象",
  retained: "因会话有效而保留",
  failed: "删除失败数量",
  pruned_dirs: "已回收空目录",
  retained_items: "已保留项目及原因",
  failures: "失败项",
  migrated: "已迁移",
  unchanged: "无需迁移",
  missing: "源对象缺失",
  media: "原图数",
  thumbs: "缩略图数",
  errors: "错误明细",
  error_count: "错误数量",
  // 迁移存储后端
  migration: "迁移结果",
  // Redis 状态
  connection: "连接状态",
  prefix_counts: "键数量统计",
  image_projection: "Redis 图片投影",
  core: "核心投影占用",
  derived: "派生缓存占用",
  recent_errors: "最近投影错误",
  coordinator: "协调器状态",
  persisted_meta: "持久化元数据",
  core_keys: "核心键",
  derived_keys: "派生键",
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
    "issues", "operations", "failures", "failed", "unavailable_backends", "error", "errors", "error_count",
    "missing_objects", "missing_thumbs",
    "orphan_objects", "orphan_thumbs", "orphan_staging_files", "ready_cache_mismatch"
  ].includes(key);
}

function storageCleanupSummary(result: Record<string, unknown>) {
  if (!("removed" in result) || !("retained_items" in result) || !("failures" in result)) {
    return null;
  }
  const removed = numericResult(result.removed);
  const retained = numericResult(result.retained);
  const failed = numericResult(result.failed);
  const candidates = numericResult(result.candidates);
  const prunedDirs = numericResult(result.pruned_dirs);
  return {
    warning: failed > 0,
    title: failed
      ? `清理完成，但有 ${failed} 项删除失败`
      : `清理完成：删除 ${removed} 项，保留 ${retained} 项`,
    detail: failed
      ? `共发现 ${candidates} 个无效候选对象；失败项仍未清理，请根据下方错误明细处理。`
      : retained
        ? `保留项均对应尚未过期的导入会话，不属于无效存储；另回收 ${prunedDirs} 个空目录。`
        : `共检查并处理 ${candidates} 个无效候选对象，另回收 ${prunedDirs} 个空目录。`
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
      total += countValue(value);
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
