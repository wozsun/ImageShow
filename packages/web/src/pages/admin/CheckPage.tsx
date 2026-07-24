import { useMemo, useState } from "react";
import { adminPermissions } from "@imageshow/shared/browser";
import { api } from "../../lib/api/client.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { Icon } from "../../components/icon/Icon.js";
import { DialogFrame } from "../../components/feedback/DialogFrame.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import { StableButtonLabel } from "../../components/data-display/StableButtonLabel.js";
import { useStorageOptions } from "../../lib/api/storage-options.js";
import { useAdminPermissions } from "../../lib/api/site-data.js";
import "../../styles/admin/check.css";

export function CheckPage() {
  const [result, setResult] = useState<unknown>(null);
  const [running, setRunning] = useState("");
  const [migrateSource, setMigrateSource] = useState("");
  const [migrateTarget, setMigrateTarget] = useState("");
  const permissions = useAdminPermissions();
  const canMigrateStorage = permissions.includes(
    adminPermissions.storageMaintenanceMigrate
  );
  const canCleanupStorage = permissions.includes(
    adminPermissions.storageMaintenanceCleanup
  );
  const { data: storageOptionsData } = useStorageOptions(canMigrateStorage);
  const storageOptions = (storageOptionsData?.backends ?? []).map((backend) => ({ value: backend.slug, label: backend.display_name || backend.slug }));
  const [operationModal, setOperationModal] = useState<"migrate-storage-location" | "storage-cleanup" | null>(null);
  const checks = useMemo(() => [
    { name: "db", label: "数据库" },
    { name: "storage", label: "存储" },
    { name: "redis", label: "Redis" },
    { name: "trash", label: "回收站" },
    { name: "all", label: "全部" }
  ], []);
  const operationAllowed = operationModal === "migrate-storage-location"
    ? canMigrateStorage
    : operationModal === "storage-cleanup"
      ? canCleanupStorage
      : false;
  const runCheck = async (name: string, body?: Record<string, unknown>) => {
    setRunning(name);
    try {
      setResult(await api(`${adminApiBasePath}/check/${name}`, { method: "POST", body: body ? JSON.stringify(body) : undefined }));
    } catch (error) {
      reportAdminUiError(`check.${name}`, error);
      setResult({ ok: false, error: "检查执行失败，请稍后重试" });
    } finally {
      setRunning("");
    }
  };
  return (
    <section className="workspace">
      <header className="workspace-head">
        <div><h1>检查</h1><p>检查数据库、Redis 与存储一致性</p></div>
        <div className="check-actions">
          <div className="actions">
            {checks.map((check) => (
              <button
                type="button"
                key={check.name}
                className={check.name === "all" ? "check-all-action" : undefined}
                disabled={Boolean(running)}
                onClick={() => void runCheck(check.name)}
              >
                <Icon name="refresh-line" /><StableButtonLabel idle={check.label} busyText="运行中" busy={running === check.name} />
              </button>
            ))}
          </div>
          {(canMigrateStorage || canCleanupStorage) && (
            <div className="actions">
              {canMigrateStorage && (
                <button
                  type="button"
                  disabled={Boolean(running)}
                  onClick={() => {
                    setOperationModal("migrate-storage-location");
                    if (storageOptions.length) {
                      setMigrateSource((value) => value || storageOptions[0].value);
                      setMigrateTarget((value) => value || (storageOptions[1]?.value ?? storageOptions[0].value));
                    }
                  }}
                >
                  <Icon name="database-2-line" /><StableButtonLabel idle="迁移存储后端" busyText="迁移中" busy={running === "migrate-storage-location"} />
                </button>
              )}
              {canCleanupStorage && (
                <button
                  className="danger-button"
                  type="button"
                  disabled={Boolean(running)}
                  onClick={() => setOperationModal("storage-cleanup")}
                >
                  <Icon name="delete-bin-6-line" /><StableButtonLabel idle="清理无效存储" busyText="清理中" busy={running === "storage-cleanup"} />
                </button>
              )}
            </div>
          )}
        </div>
      </header>
      {operationModal && operationAllowed && (
        <CheckOperationModal
          operation={operationModal}
          running={running}
          source={migrateSource}
          target={migrateTarget}
          options={storageOptions}
          onSourceChange={setMigrateSource}
          onTargetChange={setMigrateTarget}
          onClose={() => setOperationModal(null)}
          onRun={async () => {
            if (operationModal === "migrate-storage-location") {
              await runCheck("migrate-storage-location", { source: migrateSource, target: migrateTarget });
            } else {
              await runCheck(operationModal);
            }
          }}
        />
      )}
      {result !== null && <CheckResult result={result} />}
    </section>
  );
}

function CheckOperationModal({ operation, running, source, target, options, onSourceChange, onTargetChange, onClose, onRun }: {
  operation: "migrate-storage-location" | "storage-cleanup";
  running: string;
  source: string;
  target: string;
  options: { value: string; label: string }[];
  onSourceChange: (value: string) => void;
  onTargetChange: (value: string) => void;
  onClose: () => void;
  onRun: () => Promise<void>;
}) {
  const isLocationMigration = operation === "migrate-storage-location";
  const title = isLocationMigration ? "迁移存储后端" : "清理无效存储";
  const description = isLocationMigration
    ? "复制图片和缩略图到目标存储后端，并更新数据库中的存储引用。"
    : "删除数据库未引用的原图、缩略图及已失效的上传暂存文件。回收站中的图片文件和其他仍被引用的对象会保留。";
  const runningText = isLocationMigration ? "迁移中" : "清理中";
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
            await onRun();
            requestClose();
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
              <Icon name="close-line" />
            </button>
          </header>
          <div className="operation-body">
            {isLocationMigration && (
              <>
                <label>
                  源后端
                  <SelectMenu
                    value={source}
                    onChange={onSourceChange}
                    options={options}
                    ariaLabel="源后端"
                  />
                </label>
                <label>
                  目标后端
                  <SelectMenu
                    value={target}
                    onChange={onTargetChange}
                    options={options}
                    ariaLabel="目标后端"
                  />
                </label>
              </>
            )}
            <p className="notice-line">此操作会修改存储对象。执行前请先运行存储检查，确认检查结果，并避免同时上传或批量编辑图片。</p>
          </div>
          <footer>
            <button type="button" disabled={Boolean(running)} onClick={() => requestClose()}>取消</button>
            <button
              className="button"
              type="submit"
              disabled={Boolean(running) || (isLocationMigration && (!source || !target || source === target))}
            >
              <Icon name="refresh-line" /><StableButtonLabel idle="开始执行" busyText={runningText} busy={running === operation} />
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
  // 数据库检查
  operations: "进行中 / 失败的任务",
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
  core_keys: "核心键",
  folder_summary: "目录映射摘要",
  random_category_counts: "随机分类计数",
  random_items: "随机池图片",
  random_generation: "随机池版本",
  ready_count: "图库就绪数",
  random_pool_count: "随机池数量",
  random_pool_mismatch: "随机池数量不一致",
  random_pool_error: "随机池错误",
  gallery_filter_options: "画廊筛选轴缓存",
  issues: "发现的问题",
  // 全部检查（概览）
  images: "图片总数",
  default_backend: "默认存储后端",
  storage: "各后端对象统计",
};

function checkResultLabel(key: string) {
  return CHECK_RESULT_LABELS[key] ?? key;
}

function isIssueKey(key: string) {
  return [
    "issues", "operations", "failures", "failed", "unavailable_backends", "error", "errors", "error_count",
    "random_pool_mismatch", "random_pool_error", "missing_objects", "missing_thumbs",
    "orphan_objects", "orphan_thumbs", "orphan_staging_files"
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
