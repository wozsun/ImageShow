import { useEffect, useRef, useState, type DragEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  storageBackendDeletionStateFromBlockers,
  type StorageBackendDeleteAction,
  type StorageBackendDeleteBlocker,
  type StorageBackendsAdminResponseDto
} from "@imageshow/shared/browser";
import { api, isApiClientError } from "../../lib/api/client.js";
import { Icon } from "../../components/icon/Icon.js";
import { AsyncActionButton } from "../../components/actions/AsyncActionButton.js";
import { ReorderControls } from "../../components/actions/ReorderControls.js";
import { ConfirmDialog } from "../../components/feedback/ConfirmDialog.js";
import { DialogFrame } from "../../components/feedback/DialogFrame.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { storageBackendDisplay, storageBackendLabel, storageTypeLabel } from "../../lib/ui/select-options.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { waitForMinimumPendingDuration } from "../../lib/ui/async-action-timing.js";
import {
  reorderItemByDirection,
  reorderItemByKey,
  reorderPositionByKey,
  type ReorderDirection
} from "../../lib/ui/reorder.js";
import type { StorageBackendAdmin } from "../../lib/types.js";
import {
  createActionFeedback,
  type ActionFeedbackState
} from "../../components/feedback/ActionFeedback.js";
import "../../styles/admin/storage.css";
import {
  ActionFeedbackOutlet,
  useActionFeedbackTarget
} from "../../components/feedback/ActionFeedbackRegion.js";
import { WorkspaceHeader } from "../../components/layout/WorkspaceHeader.js";
import { StorageBackendModal } from "./StorageBackendModal.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { invalidateStorageData } from "../../lib/api/query-invalidation.js";
import {
  useAsyncActionStatus,
  type AsyncActionStatus
} from "../../hooks/useAsyncActionStatus.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import { migrateStorageLocation } from "../../lib/api/storage-migration.js";
import { StorageLocationMigrationDialog } from "./StorageLocationMigrationDialog.js";
import { useReorderControlFocus } from "../../hooks/useReorderControlFocus.js";

type StorageActionDialog =
  | { kind: "delete"; backend: StorageBackendAdmin; error?: string }
  | { kind: "migrate"; backend: StorageBackendAdmin }
  | { kind: "blocked"; backend: StorageBackendAdmin };

// 存储管理：命名存储后端的注册表 CRUD（卡片列表 + 精确移动/桌面拖动排序），新建/编辑走 StorageBackendModal。
export function StorageSettings() {
  return <StorageBackendsManager />;
}

function StorageBackendsManager() {
  const client = useQueryClient();
  const query = useQuery<StorageBackendsAdminResponseDto>({
    queryKey: queryKeys.storageBackends,
    queryFn: ({ signal }) => api(`${adminApiBasePath}/storage/backends`, { signal }),
    refetchInterval: (currentQuery) => currentQuery.state.data?.backends.some(
      (backend) => backend.cleanup_job_count > backend.exhausted_cleanup_job_count
    ) ? 2_000 : false
  });
  const [busy, setBusy] = useState("");
  const [reordering, setReordering] = useState(false);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const feedbackTarget = useActionFeedbackTarget("storage-settings");
  const defaultAction = useAsyncActionStatus();
  const defaultActionRunning = useRef(false);
  const [defaultActionSlug, setDefaultActionSlug] = useState("");
  const [editing, setEditing] = useState<StorageBackendAdmin | "new" | null>(null);
  const [actionDialog, setActionDialog] = useState<StorageActionDialog | null>(null);
  const backends = query.data?.backends ?? [];
  const defaultBackend = backends.find((backend) => backend.is_default);
  const defaultSlug = defaultBackend?.slug ?? "local";
  const hasNonLocalBackend = backends.some((backend) => backend.slug !== "local");
  const operationBusy = Boolean(busy) || reordering;

  const [order, setOrder] = useState<StorageBackendAdmin[]>([]);
  const orderRef = useRef<StorageBackendAdmin[]>([]);
  const dragSlug = useRef<string | null>(null);
  const dragStartOrder = useRef<StorageBackendAdmin[]>([]);
  const reorderRunning = useRef(false);
  const reorderFeedbackId = useRef<number | null>(null);
  useEffect(() => {
    if (reorderRunning.current || dragSlug.current) return;
    const items = query.data?.backends ?? [];
    orderRef.current = items;
    setOrder(items);
  }, [query.data]);

  const isFixedBackend = (backend: StorageBackendAdmin) => (
    backend.slug === "local"
  );
  const {
    registerReorderControl,
    requestReorderFocus
  } = useReorderControlFocus({
    itemSlugs: order
      .filter((backend) => !isFixedBackend(backend))
      .map((backend) => backend.slug)
  });

  const executeStorageAction = async <Result,>(
    key: string,
    action: () => Promise<Result>
  ): Promise<
    | { succeeded: true; value: Result }
    | { succeeded: false; error?: unknown }
  > => {
    if (busy) return { succeeded: false };
    setBusy(key);
    try {
      const value = await action();
      return { succeeded: true, value };
    } catch (error) {
      reportAdminUiError(`storage.${key}`, error);
      return { succeeded: false, error };
    } finally {
      await invalidateStorageData(client).catch((error) => {
        reportAdminUiError(`storage.${key}.refresh`, error);
      });
      setBusy("");
    }
  };

  const runStorageAction = async (
    key: string,
    action: () => Promise<unknown>
  ) => (await executeStorageAction(key, action)).succeeded;

  const replaceOrder = (items: StorageBackendAdmin[]) => {
    orderRef.current = items;
    setOrder(items);
  };

  const positionText = (
    items: StorageBackendAdmin[],
    movedSlug: string
  ) => {
    const position = reorderPositionByKey(
      items,
      movedSlug,
      (backend) => backend.slug,
      isFixedBackend
    );
    return position
      ? `可排序项第 ${position.position} / ${position.total} 位`
      : "当前位置不可用";
  };

  const backendName = (
    items: StorageBackendAdmin[],
    movedSlug: string
  ) => {
    const backend = items.find((candidate) => candidate.slug === movedSlug);
    return `存储后端“${
      backend ? storageBackendDisplay(backend) : storageBackendLabel(movedSlug)
    }”`;
  };

  const showReorderFeedback = (
    text: string,
    status: "pending" | "success" | "error"
  ) => {
    const nextFeedback = createActionFeedback(text, status);
    reorderFeedbackId.current = nextFeedback.id;
    setFeedback(nextFeedback);
    setReorderAnnouncement(text);
  };

  const persistOrder = async ({
    nextOrder,
    previousOrder,
    movedSlug,
    focusDirection
  }: {
    nextOrder: StorageBackendAdmin[];
    previousOrder: StorageBackendAdmin[];
    movedSlug: string;
    focusDirection: ReorderDirection | null;
  }) => {
    if (reorderRunning.current || busy) return;

    reorderRunning.current = true;
    setReordering(true);
    replaceOrder(nextOrder);
    if (focusDirection) {
      requestReorderFocus(movedSlug, focusDirection);
    }
    showReorderFeedback("正在保存排序...", "pending");
    const startedAt = Date.now();

    try {
      const slugs = nextOrder
        .filter((backend) => !isFixedBackend(backend))
        .map((backend) => backend.slug);
      const succeeded = await runStorageAction(
        "reorder",
        () => api(`${adminApiBasePath}/storage/backends/reorder`, {
          method: "POST",
          body: JSON.stringify({ slugs })
        })
      );
      await waitForMinimumPendingDuration(startedAt);

      const queryState = client.getQueryState(queryKeys.storageBackends);
      const cached = client.getQueryData<StorageBackendsAdminResponseDto>(
        queryKeys.storageBackends
      );
      const refreshed = Boolean(
        cached
        && queryState?.status === "success"
        && !queryState.isInvalidated
      );
      const authoritativeOrder = refreshed
        ? cached?.backends ?? previousOrder
        : succeeded
          ? nextOrder
          : previousOrder;

      replaceOrder(authoritativeOrder);
      if (focusDirection) {
        requestReorderFocus(movedSlug, focusDirection);
      }
      const actualPosition = positionText(authoritativeOrder, movedSlug);
      const label = backendName(authoritativeOrder, movedSlug);
      const message = succeeded
        ? `${label}排序已保存，当前为${actualPosition}`
        : refreshed
          ? `${label}排序保存失败，已按服务器顺序恢复到${actualPosition}`
          : `${label}排序保存失败，已恢复到上次已知的${actualPosition}`;
      showReorderFeedback(
        message,
        succeeded ? "success" : "error"
      );
    } finally {
      reorderRunning.current = false;
      setReordering(false);
    }
  };

  const moveByKeyboard = (
    movedSlug: string,
    direction: ReorderDirection
  ) => {
    if (operationBusy || reorderRunning.current) return;
    const previousOrder = orderRef.current;
    const result = reorderItemByDirection(
      previousOrder,
      movedSlug,
      direction,
      (backend) => backend.slug,
      isFixedBackend
    );
    if (!result.moved) return;
    void persistOrder({
      nextOrder: result.items,
      previousOrder,
      movedSlug,
      focusDirection: direction
    });
  };

  const beginDrag = (movedSlug: string) => {
    if (operationBusy || reorderRunning.current || movedSlug === "local") return;
    dragSlug.current = movedSlug;
    dragStartOrder.current = orderRef.current;
  };

  const moveOver = (targetSlug: string) => {
    const from = dragSlug.current;
    if (!from || operationBusy || reorderRunning.current) return;
    const result = reorderItemByKey(
      orderRef.current,
      from,
      targetSlug,
      (backend) => backend.slug,
      isFixedBackend
    );
    if (result.moved) replaceOrder(result.items);
  };

  const finishDrag = () => {
    const movedSlug = dragSlug.current;
    dragSlug.current = null;
    if (!movedSlug) return;
    const previousOrder = dragStartOrder.current;
    dragStartOrder.current = [];
    const nextOrder = orderRef.current;
    if (operationBusy || reorderRunning.current) {
      replaceOrder(
        client.getQueryData<StorageBackendsAdminResponseDto>(
          queryKeys.storageBackends
        )?.backends ?? previousOrder
      );
      return;
    }
    const changed = previousOrder.some(
      (backend, index) => backend.slug !== nextOrder[index]?.slug
    ) || previousOrder.length !== nextOrder.length;
    if (!changed) {
      replaceOrder(
        client.getQueryData<StorageBackendsAdminResponseDto>(
          queryKeys.storageBackends
        )?.backends ?? previousOrder
      );
      return;
    }
    void persistOrder({
      nextOrder,
      previousOrder,
      movedSlug,
      focusDirection: null
    });
  };

  const testConfig = async (body: unknown): Promise<boolean> => {
    if (busy) return false;
    setBusy("test");
    try {
      await api(`${adminApiBasePath}/storage/test`, { method: "POST", body: JSON.stringify(body) });
      return true;
    } catch (error) {
      reportAdminUiError("storage.connection_test", error);
      return false;
    } finally {
      setBusy("");
    }
  };

  const setDefault = async (slug: string) => {
    if (defaultActionRunning.current || busy) return false;
    defaultActionRunning.current = true;
    setDefaultActionSlug(slug);
    try {
      return await defaultAction.run(() => runStorageAction(
        `default:${slug}`,
        () => api(`${adminApiBasePath}/storage/backends/${slug}/default`, { method: "POST" })
      ));
    } finally {
      defaultActionRunning.current = false;
    }
  };

  const deleteBackend = async (backend: StorageBackendAdmin) => {
    if (busy) return false;
    const result = await executeStorageAction(
      `delete:${backend.slug}`,
      () => api(`${adminApiBasePath}/storage/backends/${backend.slug}/delete`, { method: "POST" })
    );
    if (!result.succeeded) {
      const refreshedBackends = client.getQueryData<
        StorageBackendsAdminResponseDto
      >(queryKeys.storageBackends)?.backends;
      const refreshedBackend = refreshedBackends?.find(
        (candidate) => candidate.slug === backend.slug
      );
      if (refreshedBackends && !refreshedBackend) {
        setActionDialog(null);
        setFeedback(createActionFeedback("存储后端已删除", "success"));
        return true;
      }
      const responseBackend = storageBackendAfterDeleteRejection(
        refreshedBackend ?? backend,
        result.error
      );
      const currentBackend = refreshedBackend
        ? storageBackendWithHiddenStagingBlocker(
          refreshedBackend,
          responseBackend
        )
        : null;
      const rejectedBackend = currentBackend
        ? currentBackend.deletion.action === "delete"
          ? null
          : currentBackend
        : responseBackend;
      if (rejectedBackend) {
        setActionDialog({
          kind: rejectedBackend.deletion.action,
          backend: rejectedBackend
        });
      } else {
        const message = isApiClientError(result.error)
          ? result.error.message
          : "存储后端删除失败，请稍后重试";
        setActionDialog((current) => current?.kind === "delete"
          ? { ...current, error: message }
          : current);
        setFeedback(createActionFeedback(message, "error"));
      }
      return false;
    }
    return true;
  };

  const migrateBackend = async (source: string, target: string) => {
    const result = await executeStorageAction(
      `migrate:${source}`,
      () => migrateStorageLocation(source, target)
    );
    if (!result.succeeded) {
      setFeedback(createActionFeedback("存储后端迁移失败，请检查配置后重试", "error"));
      return false;
    }

    const migration = result.value.migration;
    if (migration.error_count) {
      setFeedback(createActionFeedback(
        `迁移未全部完成：已迁移 ${migration.migrated} 张，失败 ${migration.error_count} 张`,
        "error"
      ));
    } else {
      setFeedback(createActionFeedback(
        migration.migrated
          ? `已迁移 ${migration.migrated} 张图片`
          : "源后端已没有需要迁移的图片",
        "success"
      ));
    }
    return true;
  };

  const retryCleanup = (slug: string) => runStorageAction(
    `cleanup-retry:${slug}`,
    () => api(`${adminApiBasePath}/storage/backends/${slug}/cleanup/retry`, {
      method: "POST"
    })
  );

  const openEditor = (target: StorageBackendAdmin | "new") => setEditing(target);
  const closeEditor = () => setEditing(null);
  const editingTarget = editing === "new"
    ? editing
    : editing
      ? backends.find((backend) => backend.slug === editing.slug) ?? editing
      : null;

  return (
    <section className="workspace">
      <WorkspaceHeader
        title="存储管理"
        description="命名存储后端：本地与多个对象存储桶可并存，可用前移/后移按钮，桌面端也可拖动排序"
        feedbackTarget={feedbackTarget}
      />
      <p
        className="reorder-live-region"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {reorderAnnouncement}
      </p>
      <p className="hint">每张图片记录自己所在的存储后端，可定义多个（同类型也可，例如两个对象存储桶）。新上传写入“默认”后端。</p>
      <p className="storage-default-note">当前默认上传后端 <strong>{defaultBackend ? storageBackendDisplay(defaultBackend) : storageBackendLabel(defaultSlug)}</strong></p>
      {query.isLoading && <p className="muted">加载中</p>}
      {query.isError && <QueryErrorState error={query.error} onRetry={() => void query.refetch()} reportContext="storage.load" />}
      <div className="storage-card-grid">
        {order.map((backend) => {
          const position = reorderPositionByKey(
            order,
            backend.slug,
            (candidate) => candidate.slug,
            isFixedBackend
          );
          return (
            <BackendCard
              key={backend.slug}
              backend={backend}
              hasNonLocalBackend={hasNonLocalBackend}
              busy={busy}
              reorderBusy={operationBusy}
              canMovePrevious={Boolean(position && position.position > 1)}
              canMoveNext={Boolean(
                position && position.position < position.total
              )}
              defaultStatus={defaultActionSlug === backend.slug
                ? defaultAction.status
                : "idle"}
              defaultActionPending={defaultAction.pending}
              onMove={(direction) => moveByKeyboard(
                backend.slug,
                direction
              )}
              onReorderControlRef={(direction, node) => {
                registerReorderControl(backend.slug, direction, node);
              }}
              onEdit={() => openEditor(backend)}
              onSetDefault={() => setDefault(backend.slug)}
              onToggleEnabled={() => runStorageAction(
                `enable:${backend.slug}`,
                () => api(`${adminApiBasePath}/storage/backends/${backend.slug}`, {
                  method: "POST",
                  body: JSON.stringify({ enabled: !backend.enabled })
                })
              )}
              onRetryCleanup={() => retryCleanup(backend.slug)}
              onRemovalAction={() => setActionDialog({
                kind: backend.deletion.action,
                backend
              })}
              onDragStart={beginDrag}
              onDragEnter={moveOver}
              onDragEnd={finishDrag}
            />
          );
        })}
        <button type="button" className="storage-add-card" disabled={operationBusy} onClick={() => openEditor("new")}>
          <Icon name="add-line" /><span>新增存储后端</span>
        </button>
      </div>
      {editingTarget && (
        <StorageBackendModal
          key={editingTarget === "new" ? "new" : editingTarget.slug}
          target={editingTarget}
          busy={busy}
          defaultStatus={editingTarget !== "new"
            && defaultActionSlug === editingTarget.slug
            ? defaultAction.status
            : "idle"}
          defaultActionPending={defaultAction.pending}
          onClose={closeEditor}
          onTest={testConfig}
          onSetDefault={setDefault}
          onSave={(slug, payload, isCreate) => runStorageAction(
            isCreate ? "create" : `save:${slug}`,
            () => isCreate
              ? api(`${adminApiBasePath}/storage/backends`, { method: "POST", body: JSON.stringify(payload) })
              : api(`${adminApiBasePath}/storage/backends/${slug}`, { method: "POST", body: JSON.stringify(payload) })
          )}
        />
      )}
      {actionDialog?.kind === "delete" && (
        <ConfirmDialog
          title={`删除“${storageBackendDisplay(actionDialog.backend)}”？`}
          description="此操作只删除存储后端配置，不会主动删除存储对象。服务端会再次确认它不是默认后端，且没有图片、导入会话、旧对象删除任务或暂存对象。删除后如需恢复，必须重新创建并配置该后端。"
          confirmLabel="确认删除"
          errorMessage={actionDialog.error}
          busy={Boolean(busy)}
          onClose={() => setActionDialog(null)}
          onConfirm={() => deleteBackend(actionDialog.backend)}
        />
      )}
      {actionDialog?.kind === "migrate" && (
        <StorageLocationMigrationDialog
          initialSource={actionDialog.backend.slug}
          busy={Boolean(busy)}
          onClose={() => setActionDialog(null)}
          onRun={migrateBackend}
        />
      )}
      {actionDialog?.kind === "blocked" && (
        <StorageDeletionBlockedDialog
          backend={actionDialog.backend}
          onClose={() => setActionDialog(null)}
        />
      )}
      {feedback && (
        <ActionFeedbackOutlet
          feedback={feedback}
          target={feedbackTarget}
          announce={feedback.id !== reorderFeedbackId.current}
          onClose={() => setFeedback(null)}
        />
      )}
    </section>
  );
}

function BackendCard({
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
    pending: {
      icon: "refresh-line",
      label: "切换中"
    },
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
      onDragEnter={() => { if (!isLocal) onDragEnter(backend.slug); }}
      onDragOver={(event) => { if (!isLocal) event.preventDefault(); }}
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
            title={backend.is_default ? "当前默认上传后端" : backend.enabled ? "设为默认上传后端" : "启用后才能设为默认"}
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
              title={backend.is_default ? "默认后端不能停用" : backend.enabled ? "已启用：新图片可写入此存储。点击停用（不影响读取与迁移）" : "已停用：新图片不能写入。点击启用"}
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
                  ? "storage-migrate-action"
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

function storageDeletionReasons(backend: StorageBackendAdmin) {
  return backend.deletion.blockers.map((blocker) => {
    switch (blocker) {
      case "built_in":
        return "local 是内置本地存储后端，不能从注册表中删除。";
      case "default":
        return "它是当前默认上传后端；请先启用其他后端并将其设为默认。";
      case "images":
        return `仍有 ${backend.image_count} 张图片使用该后端；请先迁移这些图片。`;
      case "import_sessions":
        return `仍有 ${backend.import_session_count} 个未清理导入会话；请等待会话清理完成。`;
      case "cleanup_jobs":
        return `仍有 ${backend.cleanup_job_count} 个旧对象删除任务；请等待任务完成，耗尽重试的任务可在卡片上重新排队。`;
      case "staging_objects":
        return "后端仍有上传暂存对象；请先运行存储检查并清理无效暂存。";
    }
  });
}

const storageBackendDeleteBlockers = new Set<StorageBackendDeleteBlocker>([
  "built_in",
  "default",
  "images",
  "import_sessions",
  "cleanup_jobs",
  "staging_objects"
]);
const storageBackendDeleteActions = new Set<StorageBackendDeleteAction>([
  "delete",
  "migrate",
  "blocked"
]);

function countFromDetails(
  details: Record<string, unknown>,
  key: string,
  fallback: number
) {
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function storageBackendAfterDeleteRejection(
  backend: StorageBackendAdmin,
  error: unknown
): StorageBackendAdmin | null {
  if (!isApiClientError(error)) return null;
  if (
    error.code !== "storage_default_delete"
    && error.code !== "storage_backend_in_use"
  ) return null;

  const details = error.details
    && typeof error.details === "object"
    && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : {};
  const deletion = details.deletion
    && typeof details.deletion === "object"
    && !Array.isArray(details.deletion)
    ? details.deletion as Record<string, unknown>
    : {};
  const action = typeof deletion.action === "string"
    && storageBackendDeleteActions.has(
      deletion.action as StorageBackendDeleteAction
    )
    ? deletion.action as StorageBackendDeleteAction
    : null;
  const blockers = Array.isArray(deletion.blockers)
    ? deletion.blockers.filter(
      (blocker): blocker is StorageBackendDeleteBlocker =>
        typeof blocker === "string"
        && storageBackendDeleteBlockers.has(
          blocker as StorageBackendDeleteBlocker
      )
    )
    : [];
  if (!action || (action !== "delete" && !blockers.length)) return null;

  return {
    ...backend,
    image_count: countFromDetails(details, "image_count", backend.image_count),
    import_session_count: countFromDetails(
      details,
      "import_session_count",
      backend.import_session_count
    ),
    cleanup_job_count: countFromDetails(
      details,
      "cleanup_job_count",
      backend.cleanup_job_count
    ),
    deletion: {
      action,
      blockers
    }
  };
}

function storageBackendWithHiddenStagingBlocker(
  backend: StorageBackendAdmin,
  responseBackend: StorageBackendAdmin | null
) {
  if (
    !responseBackend?.deletion.blockers.includes("staging_objects")
    || backend.deletion.blockers.includes("staging_objects")
  ) return backend;
  return {
    ...backend,
    deletion: storageBackendDeletionStateFromBlockers([
      ...backend.deletion.blockers,
      "staging_objects"
    ])
  };
}

function StorageDeletionBlockedDialog({
  backend,
  onClose
}: {
  backend: StorageBackendAdmin;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const reasons = storageDeletionReasons(backend);
  return (
    <DialogFrame
      className="modal edit-modal"
      ariaLabel="不能删除存储后端"
      initialFocusRef={closeButtonRef}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <form
          className="operation-modal storage-deletion-blocked-dialog"
          onSubmit={(event) => {
            event.preventDefault();
            requestClose();
          }}
        >
          <header>
            <div>
              <h2>暂时不能删除“{storageBackendDisplay(backend)}”</h2>
            </div>
          </header>
          <div className="operation-body">
            <ul>
              {(reasons.length
                ? reasons
                : ["当前状态不允许删除，请刷新页面后重试。"]
              ).map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          </div>
          <footer>
            <button ref={closeButtonRef} className="button" type="submit">
              知道了
            </button>
          </footer>
        </form>
      )}
    </DialogFrame>
  );
}
