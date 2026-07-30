import { useRef, useState, type DragEvent } from "react";
import { AsyncActionButton } from "../../../components/actions/AsyncActionButton.js";
import { ReorderControls } from "../../../components/actions/ReorderControls.js";
import { Icon } from "../../../components/icon/Icon.js";
import {
  useAsyncActionStatus,
  type AsyncActionStatus
} from "../../../hooks/useAsyncActionStatus.js";
import type { StorageBackendAdmin } from "../../../lib/types.js";
import {
  storageBackendLabel,
  storageTypeLabel
} from "../../../lib/ui/select-options.js";
import type { ReorderDirection } from "../../../lib/ui/reorder.js";

export function StorageBackendCard({
  backend,
  hasNonLocalBackend,
  busy,
  reorderBusy,
  canMovePrevious,
  canMoveNext,
  defaultStatus,
  defaultActionPending,
  onMove,
  onReorderControlRef,
  onEdit,
  onSetDefault,
  onRemovalAction,
  onToggleEnabled,
  onRetryCleanup,
  onDragStart,
  onDragEnter,
  onDragEnd
}: {
  backend: StorageBackendAdmin;
  hasNonLocalBackend: boolean;
  busy: string;
  reorderBusy: boolean;
  canMovePrevious: boolean;
  canMoveNext: boolean;
  defaultStatus: AsyncActionStatus;
  defaultActionPending: boolean;
  onMove: (direction: ReorderDirection) => void;
  onReorderControlRef: (
    direction: ReorderDirection,
    node: HTMLButtonElement | null
  ) => void;
  onEdit: () => void;
  onSetDefault: () => Promise<boolean>;
  onRemovalAction: () => void;
  onToggleEnabled: () => Promise<boolean>;
  onRetryCleanup: () => Promise<boolean>;
  onDragStart: (slug: string) => void;
  onDragEnter: (slug: string) => void;
  onDragEnd: () => void;
}) {
  const isLocal = backend.slug === "local";
  const showEnabledToggle = !isLocal || hasNonLocalBackend;
  const cardRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const enabledStatus = useAsyncActionStatus({ successDurationMs: null });
  const cleanupRetryStatus = useAsyncActionStatus();
  const title = backend.display_name || storageBackendLabel(backend.slug);
  const cardBusy = Boolean(busy)
    || reorderBusy
    || defaultActionPending
    || enabledStatus.pending
    || cleanupRetryStatus.pending;
  const defaultPresentation = {
    idle: {
      icon: backend.is_default ? "star-fill" : "star-line",
      label: backend.is_default ? "默认" : "设为默认"
    },
    pending: { icon: "star-line", label: "设置中" },
    success: { icon: "check-line", label: "已设默认" },
    error: { icon: "close-line", label: "设置失败" }
  } as const;
  const enabledPresentation = {
    idle: {
      icon: backend.enabled ? "check-line" : "close-line",
      label: backend.enabled ? "已启用" : "已停用"
    },
    pending: { icon: "refresh-line", label: "切换中" },
    success: {
      icon: "check-line",
      label: backend.enabled ? "已启用" : "已停用"
    },
    error: { icon: "close-line", label: "操作失败" }
  } as const;
  const cleanupRetryPresentation = {
    idle: { icon: "refresh-line", label: "重试删除" },
    pending: { icon: "refresh-line", label: "排队中" },
    success: { icon: "check-line", label: "已排队" },
    error: { icon: "close-line", label: "重试失败" }
  } as const;
  const cleanupRetryTitle = backend.exhausted_cleanup_job_count > 0
    ? `将 ${backend.exhausted_cleanup_job_count} 个已停止自动重试的旧对象删除任务重新加入后台队列；不会执行存储检查`
    : "旧对象删除任务已重新排队；不会执行存储检查";
  const begin = (event: DragEvent<HTMLSpanElement>) => {
    if (cardBusy) {
      event.preventDefault();
      return;
    }
    setDragging(true);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", backend.slug);
    onDragStart(backend.slug);
  };

  return (
    <div
      ref={cardRef}
      className={`storage-backend-card${backend.is_default ? " is-default" : ""}${backend.enabled ? "" : " is-off"}${dragging ? " is-dragging" : ""}`}
      onDragEnter={() => {
        if (!isLocal) onDragEnter(backend.slug);
      }}
      onDragOver={(event) => {
        if (!isLocal) event.preventDefault();
      }}
    >
      <div className="storage-card-body">
        <div className="storage-card-title">
          <strong title={title}>{title}</strong>
          <AsyncActionButton
            type="button"
            className={`storage-default-toggle${backend.is_default ? " is-default" : ""}`}
            status={defaultStatus}
            presentation={defaultPresentation}
            disabled={cardBusy || backend.is_default || !backend.enabled}
            title={backend.is_default
              ? "当前默认上传后端"
              : backend.enabled
                ? "设为默认上传后端"
                : "启用后才能设为默认"}
            onClick={() => void onSetDefault()}
          />
        </div>
        <div className="storage-card-meta">
          {backend.slug} · {storageTypeLabel(backend.type)} · {backend.image_count} 张图片
          {backend.import_session_count > 0
            ? ` · ${backend.import_session_count} 个未清理导入会话`
            : ""}
          {backend.cleanup_job_count > 0
            ? ` · 旧对象删除 ${backend.cleanup_job_count} 项`
            : ""}
          {backend.failed_cleanup_job_count > 0
            ? `（${backend.failed_cleanup_job_count} 项失败）`
            : ""}
        </div>
      </div>
      <div className="storage-card-actions">
        <span className="storage-card-actions-left">
          {showEnabledToggle && (
            <AsyncActionButton
              type="button"
              className={`storage-enable-toggle${backend.enabled && enabledStatus.status === "idle" ? " is-on" : ""}`}
              status={enabledStatus.status}
              presentation={enabledPresentation}
              disabled={cardBusy || backend.is_default}
              title={backend.is_default
                ? "默认后端不能停用"
                : backend.enabled
                  ? "已启用：新图片可写入此存储。点击停用（不影响读取与迁移）"
                  : "已停用：新图片不能写入。点击启用"}
              onClick={() => void enabledStatus.run(onToggleEnabled)}
            />
          )}
          {(backend.exhausted_cleanup_job_count > 0
            || cleanupRetryStatus.status !== "idle") && (
            <AsyncActionButton
              type="button"
              className="storage-cleanup-retry"
              status={cleanupRetryStatus.status}
              presentation={cleanupRetryPresentation}
              disabled={cardBusy}
              title={cleanupRetryTitle}
              onClick={() => void cleanupRetryStatus.run(onRetryCleanup)}
            />
          )}
        </span>
        <span className="storage-card-actions-right">
          {!isLocal && (
            <ReorderControls
              itemLabel={`存储后端 ${backend.slug}`}
              busy={cardBusy}
              canMovePrevious={canMovePrevious}
              canMoveNext={canMoveNext}
              onMove={onMove}
              onControlRef={onReorderControlRef}
              dragPreviewRef={cardRef}
              onDragStart={begin}
              onDragEnd={() => {
                setDragging(false);
                onDragEnd();
              }}
            />
          )}
          <button
            type="button"
            className="icon"
            title="编辑"
            disabled={cardBusy}
            onClick={onEdit}
          >
            <Icon name="pencil-line" />
          </button>
          <button
            type="button"
            className={[
              "icon",
              backend.deletion.action === "delete"
                ? "is-danger"
                : backend.deletion.action === "migrate"
                  ? "storage-backend-migrate-action"
                  : "storage-blocked-action"
            ].join(" ")}
            title={backend.deletion.action === "delete"
              ? "删除"
              : backend.deletion.action === "migrate"
                ? "迁移图片"
                : isLocal
                  ? "本地存储禁止删除"
                  : "查看原因"}
            aria-label={backend.deletion.action === "delete"
              ? "删除存储后端"
              : backend.deletion.action === "migrate"
                ? "迁移存储后端中的图片"
                : isLocal
                  ? "本地存储禁止删除"
                  : "查看存储后端不能删除的原因"}
            disabled={cardBusy}
            onClick={onRemovalAction}
          >
            <Icon name={backend.deletion.action === "delete"
              ? "delete-bin-6-line"
              : backend.deletion.action === "migrate"
                ? "arrow-left-right-line"
                : "information-line"} />
          </button>
        </span>
      </div>
    </div>
  );
}
