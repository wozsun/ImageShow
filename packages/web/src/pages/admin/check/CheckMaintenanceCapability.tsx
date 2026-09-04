import { useEffect, useRef, useState } from "react";
import {
  useQueryClient,
  type UseQueryResult
} from "@tanstack/react-query";
import {
  adminApiBasePath,
  type AdminCheckStatusDto,
  type AdminTrashCheckDto
} from "@imageshow/shared/browser";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { StableButtonLabel } from "../../../components/data-display/StableButtonLabel.js";
import { DialogFrame } from "../../../components/feedback/DialogFrame.js";
import { api } from "../../../lib/api/client.js";
import { queryKeys } from "../../../lib/api/query-keys.js";
import { invalidateStorageData } from "../../../lib/api/query-invalidation.js";
import {
  readyImageCacheRebuildPath,
  readyImageProjection
} from "../../../lib/api/ready-image-cache.js";
import { migrateStorageBackendImages } from "../../../lib/api/storage-backend-image-migration.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import { ReadyImageCachePanel } from "./ReadyImageCachePanel.js";
import type {
  ReadyImageProjectionUsageSnapshot
} from "./check-redis-inspection.js";
import { StorageBackendMigrationDialog } from "../storage/StorageBackendMigrationDialog.js";
import { storageMaintenancePreview } from "../storage/storage-maintenance-preview.js";
import "../../../styles/admin/check-maintenance.css";

type RunCheck = (
  name: string,
  body?: Record<string, unknown>
) => Promise<unknown | null>;

type TrashMaintenanceIssue = Pick<
  AdminTrashCheckDto["issues"][number],
  "kind" | "count"
>;

type TrashMaintenancePreview = {
  unqueued_count: number;
  purge_pending_count: number;
  job_counts: AdminTrashCheckDto["job_counts"];
  issues: TrashMaintenanceIssue[];
};

const trashPurgeJobStates = [
  "pending",
  "running",
  "retrying",
  "exhausted"
] as const;
const trashCheckIssueKinds = [
  "missing_job_reference",
  "wrong_job_type",
  "succeeded_job_reference",
  "stalled_job"
] as const;

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isTrashMaintenancePreview(
  value: unknown
): value is TrashMaintenancePreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const jobCounts = candidate.job_counts;
  return isCount(candidate.unqueued_count)
    && isCount(candidate.purge_pending_count)
    && Boolean(jobCounts)
    && typeof jobCounts === "object"
    && !Array.isArray(jobCounts)
    && trashPurgeJobStates.every((state) => (
      isCount((jobCounts as Record<string, unknown>)[state])
    ))
    && Array.isArray(candidate.issues)
    && candidate.issues.every((issue) => {
      if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
        return false;
      }
      const record = issue as Record<string, unknown>;
      return trashCheckIssueKinds.includes(
        record.kind as typeof trashCheckIssueKinds[number]
      ) && isCount(record.count);
    });
}

type StorageMaintenancePreviewState = {
  storage: unknown;
  trash: TrashMaintenancePreview;
};

export function CheckStorageMaintenanceActions({
  canMaintainStorage,
  canMigrateStorage,
  running,
  onPublishResult,
  onRunCheck,
  onRunningChange,
  onShowStorage
}: {
  canMaintainStorage: boolean;
  canMigrateStorage: boolean;
  running: string;
  onPublishResult: (value: unknown) => void;
  onRunCheck: RunCheck;
  onRunningChange: (value: string) => void;
  onShowStorage: () => void;
}) {
  const client = useQueryClient();
  const [maintenancePreview, setMaintenancePreview] = useState<
    StorageMaintenancePreviewState | null
  >(null);
  const [operationModal, setOperationModal] = useState<
    | "storage-backend-image-migration"
    | "storage-maintenance"
    | null
  >(null);

  const openStorageMaintenance = async () => {
    onShowStorage();
    onRunningChange("storage-maintenance-preview");
    try {
      const [storage, trash] = await Promise.all([
        api(`${adminApiBasePath}/check/storage`, { method: "POST" }),
        api(`${adminApiBasePath}/check/trash`, { method: "POST" })
      ]);
      if (
        !storageMaintenancePreview(storage)
        || !isTrashMaintenancePreview(trash)
      ) {
        throw new Error("Storage maintenance preview is incomplete");
      }
      const preview = { storage, trash };
      setMaintenancePreview(preview);
      onPublishResult(preview);
      setOperationModal("storage-maintenance");
    } catch (error) {
      reportAdminUiError("storage.maintenance.preview", error);
      onPublishResult({ ok: false, error: "存储维护预览失败，请稍后重试" });
    } finally {
      onRunningChange("");
    }
  };
  const runStorageMaintenance = async () => (
    await onRunCheck("storage-maintenance") !== null
  );
  const runStorageMigration = async (source: string, target: string) => {
    onRunningChange("storage-backend-image-migration");
    try {
      onPublishResult(await migrateStorageBackendImages(source, target));
      return true;
    } catch (error) {
      reportAdminUiError("storage.backend_migration", error);
      onPublishResult({
        ok: false,
        error: "迁移执行失败，请检查存储配置后重试"
      });
      return false;
    } finally {
      await invalidateStorageData(client).catch((error) => {
        reportAdminUiError("storage.backend_migration.refresh", error);
      });
      onRunningChange("");
    }
  };
  return (
    <>
      <div className="actions">
        {canMigrateStorage && (
          <button
            type="button"
            disabled={Boolean(running)}
            onClick={() => setOperationModal("storage-backend-image-migration")}
          >
            <AdminIcon name="database-2-line" />
            <StableButtonLabel
              idle="迁移存储后端"
              busyText="迁移中"
              busy={running === "storage-backend-image-migration"}
            />
          </button>
        )}
        {canMaintainStorage && (
          <button
            type="button"
            disabled={Boolean(running)}
            onClick={() => void openStorageMaintenance()}
          >
            <AdminIcon name="database-2-line" />
            <StableButtonLabel
              idle="存储维护"
              busyText="处理中"
              busy={running === "storage-maintenance-preview"
                || running === "storage-maintenance"}
            />
          </button>
        )}
      </div>
      {operationModal === "storage-backend-image-migration"
        && canMigrateStorage && (
          <StorageBackendMigrationDialog
            busy={Boolean(running)}
            onClose={() => setOperationModal(null)}
            onRun={runStorageMigration}
          />
        )}
      {operationModal === "storage-maintenance"
        && canMaintainStorage
        && maintenancePreview && (
        <StorageMaintenanceDialog
          preview={maintenancePreview}
          running={running}
          onClose={() => {
            setOperationModal(null);
            setMaintenancePreview(null);
          }}
          onRun={runStorageMaintenance}
        />
      )}
    </>
  );
}

function StorageMaintenanceDialog({ preview, running, onClose, onRun }: {
  preview: StorageMaintenancePreviewState;
  running: string;
  onClose: () => void;
  onRun: () => Promise<boolean>;
}) {
  const [errorMessage, setErrorMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const summary = storageMaintenancePreview(preview.storage);
  const repairableReferences = preview.trash.issues
    .filter((issue) => [
      "missing_job_reference",
      "wrong_job_type",
      "succeeded_job_reference"
    ].includes(issue.kind))
    .reduce((total, issue) => total + issue.count, 0);
  const stalledJobs = preview.trash.issues
    .filter((issue) => issue.kind === "stalled_job")
    .reduce((total, issue) => total + issue.count, 0);
  const title = "存储维护";
  const description = "修复缩略图与孤儿对象，并维护已请求彻底删除的持久任务。普通回收站图片和有效内容接入仍会保留。";
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
              setErrorMessage("存储维护执行失败，请稍后重试。");
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
            <section className="storage-maintenance-section">
              <h3>存储对象</h3>
              {summary && <dl className="storage-maintenance-preview">
                <div>
                  <dt>可重建缩略图</dt>
                  <dd>{summary.repairable_thumbnails.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>缺失原图</dt>
                  <dd>{summary.missing_originals.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>可清理对象</dt>
                  <dd>{summary.removable_objects.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>受保护内容接入暂存</dt>
                  <dd>{summary.protected_staging_objects.toLocaleString()}</dd>
                </div>
              </dl>}
            </section>
            <section className="storage-maintenance-section">
              <h3>持久彻底删除任务</h3>
              <dl className="trash-purge-maintenance-preview">
                <div><dt>待彻底删除</dt><dd>{preview.trash.purge_pending_count.toLocaleString()}</dd></div>
                <div><dt>将重试耗尽任务</dt><dd>{preview.trash.job_counts.exhausted.toLocaleString()}</dd></div>
                <div><dt>将修复异常引用</dt><dd>{repairableReferences.toLocaleString()}</dd></div>
                <div><dt>保留普通回收站</dt><dd>{preview.trash.unqueued_count.toLocaleString()}</dd></div>
              </dl>
            </section>
            <p className="notice-line">
              以上仅为当前检查预览。执行时服务端会在独占维护锁内重新读取数据库和完整存储快照；
              {summary && (
                summary.blocked_namespaces
                || summary.unavailable_logical_backends
              )
                ? `当前另有 ${[
                  summary.blocked_namespaces
                    ? `${summary.blocked_namespaces} 个不可用或列举不完整的命名空间`
                    : "",
                  summary.unavailable_logical_backends
                    ? `${summary.unavailable_logical_backends} 个不可读逻辑后端`
                    : ""
                ].filter(Boolean).join("、")}，${summary.blocked_items} 个相关项目只报告、不计入可执行数量。`
                : "预览之后发生的上传或迁移不会直接沿用旧结果。"}
              持久任务维护也会按执行时真值修复异常引用并重试全部仍有成员的耗尽任务；
              {stalledJobs
                ? `${stalledJobs} 个仍标记为运行中的停滞任务只报告，不会被强行接管。`
                : "当前没有需要人工接管的停滞任务。"}
            </p>
            <label className="storage-maintenance-confirmation">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={Boolean(running)}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>我已核对预览，并确认执行存储对象维护及持久彻底删除任务维护。</span>
            </label>
            {errorMessage && (
              <p className="admin-error" role="alert">{errorMessage}</p>
            )}
          </div>
          <footer>
            <button
              type="button"
              disabled={Boolean(running)}
              onClick={() => requestClose()}
            >
              取消
            </button>
            <button
              className="button"
              type="submit"
              disabled={Boolean(running) || !confirmed || !summary}
            >
              <AdminIcon name="refresh-line" />
              <StableButtonLabel
                idle="开始维护"
                busyText="维护中"
                busy={running === "storage-maintenance"}
              />
            </button>
          </footer>
        </form>
      )}
    </DialogFrame>
  );
}

type RebuildErrorBaseline = {
  dataUpdatedAt: number;
  hadStatus: boolean;
  state: string | null;
  reason: string | null;
  appliedRevision: string | null;
};

export function ReadyImageCacheMaintenancePanel({
  query,
  projectionUsage = null,
  projectionUsageNotice = ""
}: {
  query: UseQueryResult<AdminCheckStatusDto, Error>;
  projectionUsage?: ReadyImageProjectionUsageSnapshot | null;
  projectionUsageNotice?: string;
}) {
  const client = useQueryClient();
  const rebuildRequestActive = useRef(false);
  const [rebuildStarting, setRebuildStarting] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [rebuildError, setRebuildError] = useState("");
  const [rebuildErrorBaseline, setRebuildErrorBaseline] = useState<
    RebuildErrorBaseline | null
  >(null);
  const status = readyImageProjection(query.data);

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
            current.state !== rebuildErrorBaseline.state
            || current.reason !== rebuildErrorBaseline.reason
            || current.applied_revision
            !== rebuildErrorBaseline.appliedRevision
          )
        )
      )
    ) {
      setRebuildError("");
      setRebuildErrorBaseline(null);
    }
  }, [query.data, query.dataUpdatedAt, query.isSuccess, rebuildErrorBaseline]);

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
      setRebuildError(
        "图片投影重建未能启动，请检查 Redis 与 PostgreSQL 状态。"
      );
      setRebuildErrorBaseline({
        dataUpdatedAt: query.dataUpdatedAt,
        hadStatus: status !== undefined,
        state: status?.state ?? null,
        reason: status?.reason ?? null,
        appliedRevision: status?.applied_revision ?? null
      });
    } finally {
      rebuildRequestActive.current = false;
      setRebuildStarting(false);
    }
  };

  return (
    <>
      <ReadyImageCachePanel
        query={query}
        projectionUsage={projectionUsage}
        projectionUsageNotice={projectionUsageNotice}
        maintenanceBusy={rebuildStarting}
        maintenanceError={rebuildError}
        onRefreshSuccess={() => {
          setRebuildError("");
          setRebuildErrorBaseline(null);
        }}
        renderMaintenanceAction={({ disabled }) => (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setConfirmRebuild(true)}
          >
            <AdminIcon name="database-2-line" />
            <StableButtonLabel
              idle="重建图片投影"
              busyText="启动中"
              busy={rebuildStarting}
            />
          </button>
        )}
      />
      {confirmRebuild && (
        <RebuildConfirmation
          busy={rebuildStarting}
          onClose={() => setConfirmRebuild(false)}
          onConfirm={rebuild}
        />
      )}
    </>
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
              <AdminIcon name="close-line" />
            </button>
          </header>
          <div className="operation-body">
            <p className="notice-line">
              只清理自有的核心与派生图片键；不会修改 PostgreSQL 图片、管理员会话、
              限流数据或随机历史。
            </p>
          </div>
          <footer>
            <button
              type="button"
              disabled={busy}
              onClick={() => requestClose()}
            >
              取消
            </button>
            <button className="button" type="submit" disabled={busy}>
              <AdminIcon name="database-2-line" />
              <StableButtonLabel
                idle="确认重建"
                busyText="启动中"
                busy={busy}
              />
            </button>
          </footer>
        </form>
      )}
    </DialogFrame>
  );
}
