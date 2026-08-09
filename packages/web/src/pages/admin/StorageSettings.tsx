import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { StorageBackendsAdminResponseDto } from "@imageshow/shared/browser";
import { api, isApiClientError } from "../../lib/api/client.js";
import { AdminIcon } from "../../components/icon/AdminIcon.js";
import { ConfirmDialog } from "../../components/feedback/ConfirmDialog.js";
import { adminApiBasePath } from "../../lib/constants.js";
import {
  storageBackendDisplay,
  storageBackendLabel
} from "../../lib/ui/select-options.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import type { StorageBackendAdmin } from "../../lib/types.js";
import {
  createActionFeedback,
  type ActionFeedbackState
} from "../../lib/ui/action-feedback.js";
import "../../styles/admin/storage.css";
import {
  ActionFeedbackOutlet,
  useActionFeedbackTarget
} from "../../components/feedback/ActionFeedbackRegion.js";
import { WorkspaceHeader } from "../../components/layout/WorkspaceHeader.js";
import { StorageBackendModal } from "./StorageBackendModal.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { invalidateStorageData } from "../../lib/api/query-invalidation.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import { migrateStorageBackend } from "../../lib/api/storage-backend-migration.js";
import { usePersistedReorder } from "../../hooks/usePersistedReorder.js";
import { StorageBackendCard } from "./storage/StorageBackendCard.js";
import { StorageBackendMigrationDialog } from "./storage/StorageBackendMigrationDialog.js";
import { StorageBackendDeletionBlockedDialog } from "./storage/StorageBackendDeletionBlockedDialog.js";
import {
  storageBackendAfterDeleteRejection,
  storageBackendWithHiddenStagingBlocker
} from "./storage/storage-backend-deletion-policy.js";

type StorageActionDialog =
  | { kind: "delete"; backend: StorageBackendAdmin; error?: string }
  | { kind: "retry-cleanup"; backend: StorageBackendAdmin }
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
  const [actionFeedback, setActionFeedback] = useState<
    ActionFeedbackState | null
  >(null);
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
  const isFixedBackend = (backend: StorageBackendAdmin) => (
    backend.slug === "local"
  );
  const reorder = usePersistedReorder<StorageBackendAdmin>({
    items: query.data?.backends,
    externalBusy: Boolean(busy),
    getKey: (backend) => backend.slug,
    isFixed: isFixedBackend,
    itemLabel: (items, movedSlug) => {
      const backend = items.find((candidate) => candidate.slug === movedSlug);
      return `存储后端“${
        backend ? storageBackendDisplay(backend) : storageBackendLabel(movedSlug)
      }”`;
    },
    save: (slugs) => api(`${adminApiBasePath}/storage/backends/reorder`, {
      method: "POST",
      body: JSON.stringify({ slugs })
    }),
    refresh: () => invalidateStorageData(client),
    readAuthoritative: () => {
      const queryState = client.getQueryState(queryKeys.storageBackends);
      const cached = client.getQueryData<StorageBackendsAdminResponseDto>(
        queryKeys.storageBackends
      );
      return cached
        && queryState?.status === "success"
        && !queryState.isInvalidated
        ? cached.backends
        : null;
    },
    reportError: (stage, error) => reportAdminUiError(
      `storage.reorder${stage === "refresh" ? "_refresh" : ""}`,
      error
    ),
    minimumPendingMs: 500,
    focus: {
      itemKeys: (items) => items
        .filter((backend) => !isFixedBackend(backend))
        .map((backend) => backend.slug)
    }
  });
  const { order } = reorder;
  const operationBusy = reorder.busy;

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
        setActionFeedback(createActionFeedback("存储后端已删除", "success"));
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
        setActionFeedback(createActionFeedback(message, "error"));
      }
      return false;
    }
    return true;
  };

  const migrateBackend = async (source: string, target: string) => {
    const result = await executeStorageAction(
      `migrate:${source}`,
      () => migrateStorageBackend(source, target)
    );
    if (!result.succeeded) {
      setActionFeedback(createActionFeedback("存储后端迁移失败，请检查配置后重试", "error"));
      return false;
    }

    const migration = result.value.migration;
    if (migration.error_count) {
      setActionFeedback(createActionFeedback(
        `迁移未全部完成：已迁移 ${migration.migrated} 张，失败 ${migration.error_count} 张`,
        "error"
      ));
    } else {
      setActionFeedback(createActionFeedback(
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
  const visibleFeedback = actionFeedback ?? reorder.feedback;
  const reorderFeedbackVisible = !actionFeedback && Boolean(reorder.feedback);

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
        {reorder.announcement}
      </p>
      <p className="hint">每张图片记录自己所在的存储后端，可定义多个（同类型也可，例如两个对象存储桶）。新上传写入“默认”后端。</p>
      <p className="storage-default-note">当前默认上传后端 <strong>{defaultBackend ? storageBackendDisplay(defaultBackend) : storageBackendLabel(defaultSlug)}</strong></p>
      {query.isLoading && <p className="muted">加载中</p>}
      {query.isError && <QueryErrorState error={query.error} onRetry={() => void query.refetch()} reportContext="storage.load" />}
      <div className="storage-card-grid">
        {order.map((backend) => {
          const position = reorder.positionFor(backend.slug);
          return (
            <StorageBackendCard
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
              onMove={(direction) => {
                setActionFeedback(null);
                reorder.moveByKeyboard(backend.slug, direction);
              }}
              onReorderControlRef={(direction, node) => {
                reorder.registerReorderControl(backend.slug, direction, node);
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
              onRetryCleanup={() => setActionDialog({
                kind: "retry-cleanup",
                backend
              })}
              onRemovalAction={() => setActionDialog({
                kind: backend.deletion.action,
                backend
              })}
              onDragStart={(slug) => {
                setActionFeedback(null);
                reorder.beginDrag(slug);
              }}
              onDragEnter={reorder.moveOver}
              onDragEnd={reorder.finishDrag}
            />
          );
        })}
        <button type="button" className="storage-add-card" disabled={operationBusy} onClick={() => openEditor("new")}>
          <AdminIcon name="add-line" /><span>新增存储后端</span>
        </button>
      </div>
      {editingTarget && (
        <StorageBackendModal
          key={editingTarget === "new" ? "new" : editingTarget.slug}
          target={editingTarget}
          busy={busy}
          onClose={closeEditor}
          onTest={testConfig}
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
      {actionDialog?.kind === "retry-cleanup" && (
        <ConfirmDialog
          title={`重试“${storageBackendDisplay(actionDialog.backend)}”的旧对象删除？`}
          description={`将 ${actionDialog.backend.exhausted_cleanup_job_count} 个已停止自动重试的旧对象删除任务重新加入后台队列。后台随后会再次删除迁移完成后遗留的源对象；此操作不会重新运行存储检查。`}
          confirmLabel="确认重试删除"
          confirmIcon="refresh-line"
          pendingLabel="正在排队"
          successLabel="已重新排队"
          busy={Boolean(busy)}
          onClose={() => setActionDialog(null)}
          onConfirm={() => retryCleanup(actionDialog.backend.slug)}
        />
      )}
      {actionDialog?.kind === "migrate" && (
        <StorageBackendMigrationDialog
          initialSource={actionDialog.backend.slug}
          busy={Boolean(busy)}
          onClose={() => setActionDialog(null)}
          onRun={migrateBackend}
        />
      )}
      {actionDialog?.kind === "blocked" && (
        <StorageBackendDeletionBlockedDialog
          backend={actionDialog.backend}
          onClose={() => setActionDialog(null)}
        />
      )}
      {visibleFeedback && (
        <ActionFeedbackOutlet
          feedback={visibleFeedback}
          target={feedbackTarget}
          announce={!reorderFeedbackVisible}
          onClose={() => {
            if (reorderFeedbackVisible) reorder.clearFeedback();
            else setActionFeedback(null);
          }}
        />
      )}
    </section>
  );
}
