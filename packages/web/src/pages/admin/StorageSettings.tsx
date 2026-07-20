import { useEffect, useRef, useState, type DragEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api/client.js";
import { Icon } from "../../components/icon/Icon.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { storageBackendDisplay, storageBackendLabel, storageTypeLabel } from "../../lib/ui/select-options.js";
import { errorMessage } from "../../lib/ui/formatters.js";
import type { StorageBackendAdmin } from "../../lib/types.js";
import {
  ActionFeedback,
  createActionFeedback,
  type ActionFeedbackState
} from "../../components/feedback/ActionFeedback.js";
import { StorageBackendModal } from "./StorageBackendModal.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { invalidateStorageData } from "../../lib/api/query-invalidation.js";

// 存储管理：命名存储后端的注册表 CRUD（卡片列表 + 拖动排序），新建/编辑走 StorageBackendModal。
export function StorageSettings() {
  return <StorageBackendsManager />;
}

function StorageBackendsManager() {
  const client = useQueryClient();
  const query = useQuery<{ backends: StorageBackendAdmin[] }>({ queryKey: ["storage-backends"], queryFn: () => api(`${adminApiBasePath}/storage/backends`) });
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const [editing, setEditing] = useState<StorageBackendAdmin | "new" | null>(null);
  const backends = query.data?.backends ?? [];
  const defaultBackend = backends.find((backend) => backend.is_default);
  const defaultSlug = defaultBackend?.slug ?? "local";
  const hasNonLocalBackend = backends.some((backend) => backend.slug !== "local");

  const [order, setOrder] = useState<StorageBackendAdmin[]>([]);
  const dragSlug = useRef<string | null>(null);
  useEffect(() => { setOrder(query.data?.backends ?? []); }, [query.data]);

  const moveOver = (targetSlug: string) => {
    const from = dragSlug.current;
    if (!from || from === targetSlug || from === "local" || targetSlug === "local") return;
    setOrder((current) => {
      const fromIdx = current.findIndex((backend) => backend.slug === from);
      const toIdx = current.findIndex((backend) => backend.slug === targetSlug);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return current;
      const next = [...current];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };

  const persistOrder = () => {
    if (!dragSlug.current) return;
    dragSlug.current = null;
    const slugs = order.filter((backend) => backend.slug !== "local").map((backend) => backend.slug);
    void runStorageAction(
      "reorder",
      () => api(`${adminApiBasePath}/storage/backends/reorder`, { method: "POST", body: JSON.stringify({ slugs }) }),
      "正在保存排序...",
      "排序已保存"
    );
  };

  const runStorageAction = async (key: string, action: () => Promise<unknown>, pending: string, success: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(key);
    setFeedback(createActionFeedback(pending, "pending"));
    try {
      await action();
      setFeedback(createActionFeedback(success, "success"));
      await invalidateStorageData(client);
      return true;
    } catch (error) {
      setFeedback(createActionFeedback(errorMessage(error), "error"));
      return false;
    } finally {
      setBusy("");
    }
  };

  const testConfig = async (body: unknown): Promise<boolean> => {
    if (busy) return false;
    setBusy("test");
    try {
      await api(`${adminApiBasePath}/storage/test`, { method: "POST", body: JSON.stringify(body) });
      return true;
    } catch {
      return false;
    } finally {
      setBusy("");
    }
  };

  const setDefault = (slug: string) => {
    const backend = backends.find((item) => item.slug === slug);
    const name = backend ? storageBackendDisplay(backend) : storageBackendLabel(slug);
    return runStorageAction(`default:${slug}`, () => api(`${adminApiBasePath}/storage/backends/${slug}/default`, { method: "POST" }), "正在切换默认后端...", `默认后端已设为 ${name}`);
  };

  const openEditor = (target: StorageBackendAdmin | "new") => setEditing(target);
  const closeEditor = () => setEditing(null);

  return (
    <section className="workspace">
      <header className="workspace-head">
        <div>
          <h1>存储管理</h1>
          <p>命名存储后端：本地与多个对象存储桶可并存</p>
        </div>
      </header>
      <p className="hint">每张图片记录自己所在的存储后端，可定义多个（同类型也可，例如两个对象存储桶）。新上传写入“默认”后端；已有图片可在图片管理处迁移到任意后端。</p>
      <p className="storage-default-note">当前默认上传后端 <strong>{defaultBackend ? storageBackendDisplay(defaultBackend) : storageBackendLabel(defaultSlug)}</strong></p>
      {query.isLoading && <p className="muted">加载中</p>}
      {query.isError && <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />}
      <div className="storage-card-grid">
        {order.map((backend) => (
          <BackendCard
            key={backend.slug}
            backend={backend}
            hasNonLocalBackend={hasNonLocalBackend}
            busy={busy}
            onEdit={() => openEditor(backend)}
            onSetDefault={() => void setDefault(backend.slug)}
            onToggleEnabled={() => void runStorageAction(
              `enable:${backend.slug}`,
              () => api(`${adminApiBasePath}/storage/backends/${backend.slug}`, { method: "POST", body: JSON.stringify({ enabled: !backend.enabled }) }),
              backend.enabled ? "正在停用后端..." : "正在启用后端...",
              backend.enabled ? "存储后端已停用" : "存储后端已启用"
            )}
            onDelete={() => void runStorageAction(
              `delete:${backend.slug}`,
              () => api(`${adminApiBasePath}/storage/backends/${backend.slug}/delete`, { method: "POST" }),
              "正在删除后端...",
              "存储后端已删除"
            )}
            onDragStart={(slug) => { dragSlug.current = slug; }}
            onDragEnter={moveOver}
            onDragEnd={persistOrder}
          />
        ))}
        <button type="button" className="storage-add-card" disabled={Boolean(busy)} onClick={() => openEditor("new")}>
          <Icon name="add-line" /><span>新增存储后端</span>
        </button>
      </div>
      {editing && (
        <StorageBackendModal
          key={editing === "new" ? "new" : editing.slug}
          target={editing}
          busy={busy}
          onClose={closeEditor}
          onTest={testConfig}
          onSetDefault={setDefault}
          onSave={(slug, payload, isCreate) => runStorageAction(
            isCreate ? "create" : `save:${slug}`,
            () => isCreate
              ? api(`${adminApiBasePath}/storage/backends`, { method: "POST", body: JSON.stringify(payload) })
              : api(`${adminApiBasePath}/storage/backends/${slug}`, { method: "POST", body: JSON.stringify(payload) }),
            isCreate ? "正在新建后端..." : "正在保存后端...",
            isCreate ? "存储后端已新建" : "存储后端已保存"
          )}
        />
      )}
      {feedback && (
        <ActionFeedback
          feedback={feedback}
          placement="floating"
          onClose={() => setFeedback(null)}
        />
      )}
    </section>
  );
}

function BackendCard({ backend, hasNonLocalBackend, busy, onEdit, onSetDefault, onDelete, onToggleEnabled, onDragStart, onDragEnter, onDragEnd }: {
  backend: StorageBackendAdmin;
  hasNonLocalBackend: boolean;
  busy: string;
  onEdit: () => void;
  onSetDefault: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onDragStart: (slug: string) => void;
  onDragEnter: (slug: string) => void;
  onDragEnd: () => void;
}) {
  const isLocal = backend.slug === "local";
  const showEnabledToggle = !isLocal || hasNonLocalBackend;

  const [armed, setArmed] = useState(false);
  const title = backend.display_name || storageBackendLabel(backend.slug);

  const begin = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", backend.slug);
    onDragStart(backend.slug);
  };

  return (
    <div
      className={`storage-backend-card${backend.is_default ? " is-default" : ""}${backend.enabled ? "" : " is-off"}${armed ? " is-dragging" : ""}`}
      draggable={armed}
      onDragStart={begin}
      onDragEnter={() => { if (!isLocal) onDragEnter(backend.slug); }}
      onDragOver={(event) => { if (!isLocal) event.preventDefault(); }}
      onDragEnd={() => { setArmed(false); onDragEnd(); }}
    >
      <div className="storage-card-body">
        <div className="storage-card-title">
          <strong title={title}>{title}</strong>
          <button
            type="button"
            className={`storage-default-toggle${backend.is_default ? " is-default" : ""}`}
            disabled={Boolean(busy) || backend.is_default || !backend.enabled}
            title={backend.is_default ? "当前默认上传后端" : backend.enabled ? "设为默认上传后端" : "启用后才能设为默认"}
            onClick={onSetDefault}
          >
            <Icon name={backend.is_default ? "star-fill" : "star-line"} />{backend.is_default ? "默认" : "设为默认"}
          </button>
        </div>
        <div className="storage-card-meta">{backend.slug} · {storageTypeLabel(backend.type)}</div>
      </div>
      <div className="storage-card-actions">
        <span className="storage-card-actions-left">
          {showEnabledToggle && (
            <button
              type="button"
              className={`storage-enable-toggle${backend.enabled ? " is-on" : ""}`}
              disabled={Boolean(busy) || backend.is_default}
              title={backend.is_default ? "默认后端不能停用" : backend.enabled ? "已启用：新图片可写入此存储。点击停用（不影响读取与迁移）" : "已停用：新图片不能写入。点击启用"}
              onClick={onToggleEnabled}
            >
              <span className="storage-enable-dot" />{backend.enabled ? "已启用" : "已停用"}
            </button>
          )}
        </span>
        <span className="storage-card-actions-right">
          {!isLocal && (
            <button
              type="button"
              className="icon storage-drag-handle"
              title="按住拖动排序"
              aria-label="拖动排序"
              onMouseDown={() => setArmed(true)}
              onMouseUp={() => setArmed(false)}
            >
              <Icon name="drag-move-2-fill" />
            </button>
          )}
          <button
            type="button"
            className="icon"
            title="编辑"
            disabled={Boolean(busy)}
            onClick={onEdit}
          >
            <Icon name="pencil-line" />
          </button>
          {!isLocal && (
            <button
              type="button"
              className="icon is-danger"
              title={backend.is_default ? "默认后端不能删除（请先切换默认）" : "删除"}
              disabled={Boolean(busy) || backend.is_default}
              onClick={onDelete}
            >
              <Icon name="delete-bin-6-line" />
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
