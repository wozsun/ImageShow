import { useEffect, useRef, useState } from "react";
import {
  useQueryClient,
  type UseQueryResult
} from "@tanstack/react-query";
import type { AdminCheckStatusDto } from "@imageshow/shared/browser";
import type {
  AdminTrashCheckDto,
  TrashPurgeMaintenanceRequestDto
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

function isTrashCheck(value: unknown): value is AdminTrashCheckDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.deleted_count === "number"
    && typeof candidate.unqueued_count === "number"
    && typeof candidate.purge_pending_count === "number"
    && Array.isArray(candidate.jobs)
    && Array.isArray(candidate.issues);
}

export function TrashPurgeMaintenanceActions({
  running,
  onRunCheck,
  onShowTrash
}: {
  running: string;
  onRunCheck: RunCheck;
  onShowTrash: () => void;
}) {
  const [preview, setPreview] = useState<AdminTrashCheckDto | null>(null);
  const [open, setOpen] = useState(false);

  const openMaintenance = async () => {
    onShowTrash();
    const checked = await onRunCheck("trash");
    const next = isTrashCheck(checked) ? checked : null;
    if (!next) return;
    setPreview(next);
    setOpen(true);
  };

  return (
    <>
      <div className="actions">
        <button
          type="button"
          disabled={Boolean(running)}
          onClick={() => void openMaintenance()}
        >
          <AdminIcon name="delete-bin-7-line" />
          <StableButtonLabel
            idle="彻底删除维护"
            busyText="检查中"
            busy={running === "trash"}
          />
        </button>
      </div>
      {open && preview && (
        <TrashPurgeMaintenanceDialog
          preview={preview}
          running={running}
          onClose={() => {
            setOpen(false);
            setPreview(null);
          }}
          onRun={(request) => onRunCheck(
            "trash-purge-maintenance",
            request
          ).then((value) => value !== null)}
        />
      )}
    </>
  );
}

type TrashPurgeMaintenanceAction = TrashPurgeMaintenanceRequestDto["action"];

function TrashPurgeMaintenanceDialog({ preview, running, onClose, onRun }: {
  preview: AdminTrashCheckDto;
  running: string;
  onClose: () => void;
  onRun: (request: TrashPurgeMaintenanceRequestDto) => Promise<boolean>;
}) {
  const exhaustedJobs = preview.jobs.filter((job) => job.state === "exhausted");
  const repairable = preview.issues.some((issue) => [
    "missing_job_reference",
    "wrong_job_type",
    "succeeded_job_reference"
  ].includes(issue.kind));
  const availableActions: TrashPurgeMaintenanceAction[] = [
    ...(exhaustedJobs.length ? ["retry" as const] : []),
    ...(repairable ? ["repair" as const] : [])
  ];
  const [action, setAction] = useState<TrashPurgeMaintenanceAction | "">(
    availableActions[0] ?? ""
  );
  const [jobId, setJobId] = useState(exhaustedJobs[0]?.id ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const busy = running === "trash-purge-maintenance";
  const title = "彻底删除维护";

  const submit = async () => {
    if (!action) return false;
    const request: TrashPurgeMaintenanceRequestDto = action === "retry"
      ? { action, job_id: jobId }
      : { action };
    setErrorMessage("");
    if (await onRun(request)) return true;
    setErrorMessage("维护未执行，请重新运行回收站检查后确认当前状态。");
    return false;
  };

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
          onSubmit={async (event) => {
            event.preventDefault();
            if (await submit()) requestClose();
          }}
        >
          <header>
            <div>
              <h2>{title}</h2>
              <p>仅处理持久彻底删除任务，不探测或恢复已经确认删除的对象。</p>
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
            <dl className="trash-purge-maintenance-preview">
              <div><dt>回收站总数</dt><dd>{preview.deleted_count.toLocaleString()}</dd></div>
              <div><dt>未排队</dt><dd>{preview.unqueued_count.toLocaleString()}</dd></div>
              <div><dt>待彻底删除</dt><dd>{preview.purge_pending_count.toLocaleString()}</dd></div>
              <div><dt>检查问题</dt><dd>{preview.issues.length.toLocaleString()}</dd></div>
            </dl>
            {availableActions.length ? (
              <div className="trash-purge-maintenance-options">
                <label>
                  <span>维护动作</span>
                  <select
                    value={action}
                    disabled={busy}
                    onChange={(event) => {
                      setAction(event.target.value as TrashPurgeMaintenanceAction);
                      setConfirmed(false);
                    }}
                  >
                    {exhaustedJobs.length > 0 && <option value="retry">重试耗尽任务</option>}
                    {repairable && <option value="repair">修复异常任务引用</option>}
                  </select>
                </label>
                {action === "retry" && (
                  <label>
                    <span>耗尽任务</span>
                    <select
                      value={jobId}
                      disabled={busy}
                      onChange={(event) => {
                        setJobId(event.target.value);
                        setConfirmed(false);
                      }}
                    >
                      {exhaustedJobs.map((job) => (
                        <option key={job.id} value={job.id}>
                          {job.id.slice(0, 8)} · {job.image_count} 张
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            ) : (
              <p className="notice-line">当前没有需要人工维护的彻底删除任务。</p>
            )}
            {availableActions.length > 0 && (
              <label className="storage-maintenance-confirmation">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>我已核对当前检查结果，并确认执行所选维护。</span>
              </label>
            )}
            {errorMessage && <p className="admin-error" role="alert">{errorMessage}</p>}
          </div>
          <footer>
            <button type="button" disabled={busy} onClick={() => requestClose()}>
              取消
            </button>
            <button
              className="button"
              type="submit"
              disabled={busy || !confirmed || !action || (action === "retry" && !jobId)}
            >
              <AdminIcon name="refresh-line" />
              <StableButtonLabel idle="执行维护" busyText="处理中" busy={busy} />
            </button>
          </footer>
        </form>
      )}
    </DialogFrame>
  );
}

export function CheckStorageMaintenanceActions({
  canMaintainStorage,
  canMigrateStorage,
  result,
  resultKind,
  running,
  onPublishResult,
  onRunCheck,
  onRunningChange,
  onShowStorage
}: {
  canMaintainStorage: boolean;
  canMigrateStorage: boolean;
  result: unknown;
  resultKind: string;
  running: string;
  onPublishResult: (value: unknown, kind: string) => void;
  onRunCheck: RunCheck;
  onRunningChange: (value: string) => void;
  onShowStorage: () => void;
}) {
  const client = useQueryClient();
  const [maintenancePreview, setMaintenancePreview] = useState<unknown>(null);
  const [operationModal, setOperationModal] = useState<
    "storage-backend-image-migration" | "storage-maintenance" | null
  >(null);

  const openStorageMaintenance = async () => {
    let preview = resultKind === "storage"
      ? storageMaintenancePreview(result) && result
      : null;
    if (!preview) {
      onShowStorage();
      preview = await onRunCheck("storage");
    }
    if (preview && storageMaintenancePreview(preview)) {
      setMaintenancePreview(preview);
      setOperationModal("storage-maintenance");
    }
  };
  const runStorageMaintenance = async () => (
    await onRunCheck("storage-maintenance") !== null
  );
  const runStorageMigration = async (source: string, target: string) => {
    onRunningChange("storage-backend-image-migration");
    try {
      onPublishResult(
        await migrateStorageBackendImages(source, target),
        "storage-backend-image-migration"
      );
      return true;
    } catch (error) {
      reportAdminUiError("storage.backend_migration", error);
      onPublishResult(
        { ok: false, error: "迁移执行失败，请检查存储配置后重试" },
        "storage-backend-image-migration"
      );
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
              busy={running === "storage" || running === "storage-maintenance"}
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
      {operationModal === "storage-maintenance" && canMaintainStorage && (
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
  preview: unknown;
  running: string;
  onClose: () => void;
  onRun: () => Promise<boolean>;
}) {
  const [errorMessage, setErrorMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const summary = storageMaintenancePreview(preview);
  const title = "存储维护";
  const description = "重建可恢复的缺失缩略图，并删除数据库确认未引用的存储对象。回收站图片和有效内容接入仍会保留。";
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
            {summary && (
              <dl className="storage-maintenance-preview">
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
              </dl>
            )}
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
            </p>
            <label className="storage-maintenance-confirmation">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={Boolean(running)}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>我已核对预览，并确认执行存储维修与孤儿对象清理。</span>
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
