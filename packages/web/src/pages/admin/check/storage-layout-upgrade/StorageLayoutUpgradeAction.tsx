import { useEffect, useRef, useState } from "react";
import {
  storageLayoutUpgradeBatchMaxItems,
  type StorageLayoutUpgradeItemResultDto,
  type StorageLayoutUpgradeStatusDto
} from "@imageshow/shared/browser";
import { AdminIcon } from "../../../../components/icon/AdminIcon.js";
import { StableButtonLabel } from "../../../../components/data-display/StableButtonLabel.js";
import { DialogFrame } from "../../../../components/feedback/DialogFrame.js";
import { formatBytes } from "../../../../lib/ui/formatters.js";
import { reportAdminUiError } from "../../../../lib/ui/error-reporting.js";
import {
  readStorageLayoutUpgradeStatus,
  runStorageLayoutUpgradeBatch
} from "./storage-layout-upgrade-api.js";
import "../../../../styles/admin/check-storage-layout-upgrade.css";

const storageLayoutUpgradeBatchSize = Math.min(
  10,
  storageLayoutUpgradeBatchMaxItems
);
const cleanupPollIntervalMs = 1_000;
const cleanupPollLimit = 30;

function waitForNextStatus(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, cleanupPollIntervalMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function failureItems(results: readonly StorageLayoutUpgradeItemResultDto[]) {
  return results.filter((item): item is Extract<
    StorageLayoutUpgradeItemResultDto,
    { status: "failed" }
  > => item.status === "failed");
}

export function StorageLayoutUpgradeAction({
  running,
  onRunningChange
}: {
  running: string;
  onRunningChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState<StorageLayoutUpgradeStatusDto | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [migrated, setMigrated] = useState(0);
  const [unchanged, setUnchanged] = useState(0);
  const [failed, setFailed] = useState(0);
  const [failures, setFailures] = useState<ReturnType<typeof failureItems>>([]);
  const operationAbort = useRef<AbortController | null>(null);
  const busy = running === "storage-layout-upgrade";

  useEffect(() => () => operationAbort.current?.abort(), []);

  const refresh = async (signal?: AbortSignal) => {
    const next = await readStorageLayoutUpgradeStatus(signal);
    setStatus(next);
    return next;
  };

  const show = async () => {
    setOpen(true);
    setLoading(true);
    setError("");
    setNotice("");
    setConfirmed(false);
    setMigrated(0);
    setUnchanged(0);
    setFailed(0);
    setFailures([]);
    try {
      await refresh();
    } catch (requestError) {
      reportAdminUiError("storage-layout-upgrade.status", requestError);
      setError("无法读取布局升级状态，请核对 PostgreSQL、Redis 与存储后重试。");
    } finally {
      setLoading(false);
    }
  };

  const execute = async () => {
    if (busy || !status || !confirmed || status.complete) return;
    const controller = new AbortController();
    operationAbort.current = controller;
    onRunningChange("storage-layout-upgrade");
    setError("");
    setNotice("");
    setMigrated(0);
    setUnchanged(0);
    setFailed(0);
    setFailures([]);
    try {
      let current = status;
      while (current.remaining_images > 0) {
        const response = await runStorageLayoutUpgradeBatch(
          storageLayoutUpgradeBatchSize,
          controller.signal
        );
        setMigrated((value) => value + response.batch.migrated);
        setUnchanged((value) => value + response.batch.unchanged);
        setFailed((value) => value + response.batch.failed);
        const batchFailures = failureItems(response.batch.results);
        setFailures(batchFailures);
        current = response.status;
        setStatus(current);
        if (batchFailures.length) {
          setError("本批存在失败项，已停止后续批次；修复原因后可从权威剩余数量继续。");
          return;
        }
        if (!response.batch.requested && current.remaining_images > 0) {
          setError("服务端未找到可迁移项，但仍报告旧布局图片；请核对对象键。");
          return;
        }
      }

      for (let attempt = 0; attempt < cleanupPollLimit; attempt += 1) {
        if (current.complete) break;
        if (
          current.remaining_images === 0
          && current.pending_media_cleanup_jobs === 0
          && current.projection.synchronized
          && (
            current.media_listing_complete
            || current.namespaces.some((item) => item.error)
          )
        ) {
          break;
        }
        await waitForNextStatus(controller.signal);
        current = await refresh(controller.signal);
      }
      if (current.complete) {
        setNotice("存储布局升级已完成，数据库、旧对象清理和图片投影均已确认收敛。");
      } else {
        setNotice("图片位置已迁移完毕，旧对象清理或图片投影仍在收尾；可稍后刷新状态继续确认。");
      }
    } catch (requestError) {
      if (controller.signal.aborted) {
        setNotice("本次连续执行已停止；重新打开后会从 PostgreSQL 当前剩余数量继续。");
      } else {
        reportAdminUiError("storage-layout-upgrade.execute", requestError);
        setError("布局升级请求失败；已完成的图片不会回退，可直接刷新状态后重试。");
      }
    } finally {
      operationAbort.current = null;
      onRunningChange("");
    }
  };

  return (
    <>
      <div className="actions storage-layout-upgrade-action">
        <button
          type="button"
          disabled={Boolean(running) || loading}
          onClick={() => void show()}
        >
          <AdminIcon name="database-2-line" />
          <StableButtonLabel
            idle="升级图片布局"
            busyText="读取中"
            busy={loading}
          />
        </button>
      </div>
      {open && (
        <StorageLayoutUpgradeDialog
          status={status}
          loading={loading}
          busy={busy}
          confirmed={confirmed}
          error={error}
          notice={notice}
          migrated={migrated}
          unchanged={unchanged}
          failed={failed}
          failures={failures}
          onConfirmedChange={setConfirmed}
          onRefresh={() => {
            setLoading(true);
            setError("");
            setNotice("");
            void refresh()
              .catch((requestError) => {
                reportAdminUiError("storage-layout-upgrade.status", requestError);
                setError("布局升级状态刷新失败，请稍后重试。");
              })
              .finally(() => setLoading(false));
          }}
          onExecute={() => void execute()}
          onStop={() => operationAbort.current?.abort()}
          onClose={() => {
            setOpen(false);
            setStatus(null);
            setError("");
            setNotice("");
          }}
        />
      )}
    </>
  );
}

function StorageLayoutUpgradeDialog({
  status,
  loading,
  busy,
  confirmed,
  error,
  notice,
  migrated,
  unchanged,
  failed,
  failures,
  onConfirmedChange,
  onRefresh,
  onExecute,
  onStop,
  onClose
}: {
  status: StorageLayoutUpgradeStatusDto | null;
  loading: boolean;
  busy: boolean;
  confirmed: boolean;
  error: string;
  notice: string;
  migrated: number;
  unchanged: number;
  failed: number;
  failures: ReturnType<typeof failureItems>;
  onConfirmedChange: (value: boolean) => void;
  onRefresh: () => void;
  onExecute: () => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const title = "升级图片存储布局";
  const completionConfirmed = status?.complete === true
    && failed === 0
    && failures.length === 0;
  const progress = completionConfirmed
    ? 100
    : status?.total_images
      ? Math.min(
          99,
          Math.floor(status.compliant_images / status.total_images * 100)
        )
      : 0;
  const blocked = status && !status.can_migrate;

  return (
    <DialogFrame
      className="modal edit-modal storage-layout-upgrade-modal"
      ariaLabel={title}
      busy={busy}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <form
          className="operation-modal"
          onSubmit={(event) => {
            event.preventDefault();
            onExecute();
          }}
        >
          <header>
            <div>
              <h2>{title}</h2>
              <p>
                把旧 <code>media</code> 分类路径迁移为稳定的 <code>full</code> 分片路径。
              </p>
            </div>
            <button
              className="icon close pressable"
              type="button"
              title="关闭"
              disabled={busy}
              onClick={() => requestClose()}
            >
              <AdminIcon name="close-line" />
            </button>
          </header>
          <div className="operation-body storage-layout-upgrade-body">
            {loading && !status && <p className="notice-line">正在读取权威迁移状态…</p>}
            {status && (
              <>
                <div
                  className="storage-layout-upgrade-progress"
                  role="progressbar"
                  aria-label="迁移进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                >
                  <div><span style={{ width: `${progress}%` }} /></div>
                  <strong>{progress}%</strong>
                </div>
                <dl className="storage-layout-upgrade-stats">
                  <div><dt>总图片</dt><dd>{status.total_images.toLocaleString()}</dd></div>
                  <div><dt>已符合新布局</dt><dd>{status.compliant_images.toLocaleString()}</dd></div>
                  <div><dt>权威剩余</dt><dd>{status.remaining_images.toLocaleString()}</dd></div>
                  <div><dt>预计剩余传输</dt><dd>{formatBytes(status.estimated_transfer_bytes)}</dd></div>
                  <div><dt>本次成功</dt><dd>{migrated.toLocaleString()}</dd></div>
                  <div><dt>本次跳过</dt><dd>{unchanged.toLocaleString()}</dd></div>
                  <div><dt>本次失败</dt><dd>{failed.toLocaleString()}</dd></div>
                  <div><dt>待清理任务</dt><dd>{status.pending_media_cleanup_jobs.toLocaleString()}</dd></div>
                  <div>
                    <dt>旧 media 对象</dt>
                    <dd>
                      {status.media_objects === null
                        ? status.namespaces.some((item) => item.error)
                          ? "无法确认"
                          : "待最终扫描"
                        : status.media_objects.toLocaleString()}
                    </dd>
                  </div>
                  <div><dt>旧接入意图</dt><dd>{status.active_legacy_ingestions.toLocaleString()}</dd></div>
                </dl>
                <p className={`notice-line ${completionConfirmed ? "success" : ""}`} role="status">
                  {completionConfirmed
                    ? "全部完成条件已由服务端确认。"
                    : status.complete
                      ? "服务端完成条件已经收敛，但本轮存在失败反馈；请关闭后重新打开以独立复核。"
                    : blocked
                      ? "当前存在升级阻断项；处理后刷新权威状态再继续。"
                    : status.remaining_images > 0
                      ? "可以分批迁移；刷新或断线后会从当前剩余图片继续。"
                    : status.media_listing_complete
                        && (status.media_objects ?? 0) > 0
                      ? `仍有 ${status.media_objects} 个旧 media 对象；请先运行存储维护清理后刷新。`
                      : "数据库迁移已结束，正在等待旧对象清理与图片投影追平。"}
                </p>
                {blocked && (
                  <p className="admin-error" role="alert">
                    {status.invalid_layout_images > 0
                      ? `存在 ${status.invalid_layout_images} 张无法识别路径的图片。`
                      : `仍有 ${status.active_legacy_ingestions} 个旧内容接入意图。`}
                  </p>
                )}
                {status.namespaces.some((item) => item.error) && (
                  <ul className="storage-layout-upgrade-errors">
                    {status.namespaces.filter((item) => item.error).map((item) => (
                      <li key={item.namespace}>{item.namespace}：{item.error}</li>
                    ))}
                  </ul>
                )}
                {!status.complete && (
                  <label className="storage-maintenance-confirmation">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={busy}
                      onChange={(event) => onConfirmedChange(event.target.checked)}
                    />
                    <span>
                      我已停止新图片接入，并理解迁移会改变 <code>/media/*</code>、
                      <code>/thumbs/*</code> 与对象存储公开直链；迁移期间短时图片失效可以接受。
                    </span>
                  </label>
                )}
              </>
            )}
            {failures.length > 0 && (
              <ul className="storage-layout-upgrade-errors">
                {failures.map((item) => (
                  <li key={item.id}>
                    {item.id} · {item.code} · {item.message}
                  </li>
                ))}
              </ul>
            )}
            {error && <p className="admin-error" role="alert">{error}</p>}
            {notice && <p className="notice-line" role="status">{notice}</p>}
          </div>
          <footer>
            {busy ? (
              <button type="button" onClick={onStop}>停止连续执行</button>
            ) : (
              <button type="button" onClick={() => requestClose()}>关闭</button>
            )}
            <button
              type="button"
              disabled={busy || loading}
              onClick={onRefresh}
            >
              <AdminIcon name="refresh-line" />
              刷新状态
            </button>
            {!status?.complete && (
              <button
                className="button"
                type="submit"
                disabled={busy || loading || !status || !status.can_migrate || !confirmed}
              >
                <AdminIcon name="database-2-line" />
                <StableButtonLabel
                  idle={status?.remaining_images ? "开始 / 继续升级" : "确认收尾状态"}
                  busyText="升级中"
                  busy={busy}
                />
              </button>
            )}
          </footer>
        </form>
      )}
    </DialogFrame>
  );
}
