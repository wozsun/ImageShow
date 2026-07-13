import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api/client.js";
import { Icon } from "../../components/icon/Icon.js";
import { ConfirmDialog } from "../../components/feedback/ConfirmDialog.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { adminApiBasePath, queryKeys } from "../../lib/constants.js";
import { errorMessage, formatDate, formatImageClassification, imageDisplayTitle } from "../../lib/ui/formatters.js";
import { useStorageNameResolver } from "../../lib/api/storage-options.js";
import type { AdminSettings, Author, ImageItem, Tag, Theme } from "../../lib/types.js";
import { ImageDetailModal } from "../../components/image/ImageDetailModal.js";
import { ThumbImage } from "../../components/image/ThumbImage.js";
import { BatchMetadataModal } from "./BatchMetadataModal.js";
import { ImageEditModal } from "./ImageEditModal.js";
import { ActionFeedback } from "../../components/feedback/ActionFeedback.js";
import { Uploader } from "./uploader/Uploader.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";

type ConfirmAction =
  | { kind: "batch-delete"; ids: string[] }
  | { kind: "empty-trash" }
  | { kind: "purge"; id: string; title: string };

// 批量恢复每批提交的张数。恢复现在是纯数据库操作（不动文件），但仍分小批依次提交：让进度
// 「恢复中… X/N」能逐批刷新、单请求有界，避免一次性大批量时按钮长时间无响应。
const restoreChunkSize = 10;

export function ImageAdmin() {

  const [searchParams, setSearchParams] = useSearchParams();
  const viewParam = searchParams.get("view");
  const [view, setView] = useState<"ready" | "unset" | "deleted">(viewParam === "unset" || viewParam === "deleted" ? viewParam : "ready");
  const [cursorHistory, setCursorHistory] = useState<string[]>([""]);
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<ImageItem | null>(null);
  const [editing, setEditing] = useState<ImageItem | null>(null);
  const [batchEditing, setBatchEditing] = useState(false);

  const [feedback, setFeedback] = useState<{ text: string; status: "pending" | "success" | "error" } | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState("");
  const gridRef = useRef<HTMLDivElement | null>(null);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const client = useQueryClient();
  const { data: settingsData } = useQuery<{ settings: AdminSettings }>({ queryKey: queryKeys.settings, queryFn: () => api(`${adminApiBasePath}/settings`) });

  const editorDataNeeded = Boolean(editing || batchEditing);
  const { data: themeData } = useQuery<{ items: Theme[] }>({ queryKey: queryKeys.themes, queryFn: () => api(`${adminApiBasePath}/themes`), enabled: editorDataNeeded });
  const themes = themeData?.items ?? [];
  const { data: tagData } = useQuery<{ items: Tag[] }>({ queryKey: queryKeys.tags, queryFn: () => api(`${adminApiBasePath}/tags`), enabled: editorDataNeeded });
  const allTags = tagData?.items ?? [];
  const { data: authorData } = useQuery<{ items: Author[] }>({ queryKey: queryKeys.authors, queryFn: () => api(`${adminApiBasePath}/authors`), enabled: editorDataNeeded });
  const authors = authorData?.items ?? [];
  // 列表卡片左下角的「所在存储」展示后端显示名（而非 slug）；从后端列表解析。
  const storageName = useStorageNameResolver();
  const pageSize = settingsData?.settings.admin.image_page_size ?? 50;
  const editPageSize = settingsData?.settings.upload.list_page_size ?? 20;
  const cursor = cursorHistory.at(-1) ?? "";
  const pageNumber = cursorHistory.length;
  const listParams = new URLSearchParams({ status: view === "deleted" ? "deleted" : "ready", limit: String(pageSize) });
  // 「未设置」页签只显示未设置主题的正常图片。
  if (view === "unset") listParams.set("t", "none");
  if (cursor) listParams.set("cursor", cursor);
  const listPath = `${adminApiBasePath}/images?${listParams}`;

  const { data, error: listError, isError: listFailed, isFetching, refetch: refetchList } = useQuery<{ items: ImageItem[]; total: number; has_next: boolean; next_cursor: string | null }>({
    queryKey: [...queryKeys.adminImages, view, cursor, pageSize],
    queryFn: () => api(listPath),
    enabled: Boolean(settingsData),
  });
  const refresh = () => {
    setSelected([]);
    setCursorHistory([""]);
    client.invalidateQueries({ queryKey: queryKeys.adminImages });
    client.invalidateQueries({ queryKey: queryKeys.galleryFacets });
    client.invalidateQueries({ queryKey: queryKeys.themes });
    client.invalidateQueries({ queryKey: queryKeys.tags });
    client.invalidateQueries({ queryKey: queryKeys.authors });
  };
  const items = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));
  const selectedItems = items.filter((item) => selected.includes(item.id));
  const allSelected = items.length > 0 && selected.length === items.length;
  const canDeleteReadyItems = view !== "deleted";
  const changeView = (next: typeof view) => {
    setView(next);
    setCursorHistory([""]);
    setSelected([]);
    setFeedback(null);

    setSearchParams(next === "ready" ? {} : { view: next }, { replace: true });
  };
  const previousPage = () => {
    setSelected([]);
    setCursorHistory((current) => current.length > 1 ? current.slice(0, -1) : current);
  };
  const nextPage = () => {
    if (!data?.next_cursor) return;
    setSelected([]);
    setCursorHistory((current) => [...current, data.next_cursor!]);
  };
  useEffect(() => setSelected([]), [cursor]);
  const runRowAction = async (item: ImageItem, action: "delete" | "restore") => {
    if (rowBusy) return;
    setRowBusy(`${action}:${item.id}`);
    setFeedback({ text: action === "delete" ? "正在删除图片…" : "正在恢复图片…", status: "pending" });
    try {
      await api(`${adminApiBasePath}/images/${item.id}/${action}`, { method: "POST" });
      setFeedback({ text: action === "delete" ? "图片已移入回收站" : "图片已恢复", status: "success" });
      refresh();
    } catch (error) {
      setFeedback({ text: `操作失败：${errorMessage(error)}`, status: "error" });
    } finally {
      setRowBusy("");
    }
  };
  const runConfirmedAction = async () => {
    if (!confirmAction) return;
    setActionBusy(true);
    try {
      if (confirmAction.kind === "batch-delete") {
        const result = await api<{ deleted: number; ignored: number }>(`${adminApiBasePath}/images/batch-delete`, { method: "POST", body: JSON.stringify({ ids: confirmAction.ids }) });
        setFeedback({ text: `已删除 ${result.deleted} 张，忽略 ${result.ignored} 张`, status: "success" });
      } else if (confirmAction.kind === "empty-trash") {
        setFeedback({ text: "正在清空回收站，请稍候…", status: "pending" });
        const result = await api<{ deleted: number; failed: number }>(`${adminApiBasePath}/images/empty-trash`, { method: "POST" });
        setFeedback({ text: `已永久删除 ${result.deleted} 张图片${result.failed ? `，${result.failed} 张存储删除失败并保留在回收站` : ""}`, status: "success" });
      } else {
        await api(`${adminApiBasePath}/images/${confirmAction.id}/purge`, { method: "POST" });
        setFeedback({ text: `已永久删除 ${confirmAction.title}`, status: "success" });
      }
      refresh();
    } catch (error) {
      setFeedback({ text: `操作失败：${errorMessage(error)}`, status: "error" });
    } finally {
      setActionBusy(false);
    }
  };
  // 批量恢复：把选中项切成小批依次提交，每批后更新「恢复中… X/N」进度，全程 actionBusy 禁用按钮，
  // 结束再汇总恢复/忽略/失败数。出错时也走 refresh，让已成功恢复的部分如实反映到列表。
  const restoreSelected = async () => {
    const ids = [...selected];
    const total = ids.length;
    if (!total) return;
    setActionBusy(true);
    setFeedback({ text: `恢复中… 0/${total} 张`, status: "pending" });
    let restored = 0;
    let ignored = 0;
    let failed = 0;
    try {
      for (let start = 0; start < total; start += restoreChunkSize) {
        const chunk = ids.slice(start, start + restoreChunkSize);
        const result = await api<{ restored: number; ignored: number; failed: number }>(
          `${adminApiBasePath}/images/batch-restore`,
          { method: "POST", body: JSON.stringify({ ids: chunk }) }
        );
        restored += result.restored;
        ignored += result.ignored;
        failed += result.failed;
        setFeedback({ text: `恢复中… ${Math.min(start + chunk.length, total)}/${total} 张`, status: "pending" });
      }
      setFeedback({ text: `已恢复 ${restored} 张，忽略 ${ignored} 张，失败 ${failed} 张`, status: "success" });
    } catch (error) {
      setFeedback({ text: `批量恢复失败：${errorMessage(error)}（已恢复 ${restored} 张）`, status: "error" });
    } finally {
      setActionBusy(false);
      refresh();
    }
  };
  const confirmCopy = confirmAction?.kind === "batch-delete"
    ? { title: "确认批量删除", description: `将选中的 ${confirmAction.ids.length} 张图片移入回收站，可以稍后恢复。`, label: "确认删除" }
    : confirmAction?.kind === "empty-trash"
      ? { title: "确认清空回收站", description: "回收站内的所有图片及存储对象将被永久删除，此操作无法撤销。", label: "永久清空" }
      : confirmAction?.kind === "purge"
        ? { title: "确认永久删除", description: `“${confirmAction.title}”将从回收站和存储中永久删除，此操作无法撤销。`, label: "永久删除" }
        : null;
  return (
    <section className="workspace workspace-paged">
      <header className="workspace-head image-admin-head">
        <div>
          <h1>图片</h1>
          <p>第 {pageNumber} / {totalPages} 页 · 共 {data?.total ?? 0} 项 · 本页 {items.length} 项{isFetching ? " · 加载中" : ""}</p>
        </div>
        <div className="image-admin-head-tools">
          {view === "ready" && <Uploader onDone={refresh} />}
          {/* 批量操作进度/结果（含回收站批量恢复的「恢复中… X/N」）就近显示在视图标签左侧。 */}
          {feedback && <ActionFeedback feedback={feedback} inline />}
          <div className="segmented">
            <button type="button" className={view === "ready" ? "active" : ""} onClick={() => changeView("ready")}>
              图库
            </button>
            <button type="button" className={view === "unset" ? "active" : ""} onClick={() => changeView("unset")}>
              未设置
            </button>
            <button type="button" className={view === "deleted" ? "active" : ""} onClick={() => changeView("deleted")}>
              回收站
            </button>
          </div>
        </div>
      </header>
      <div className="toolbar">
        <div className="inline-actions">
          <label className="check-label">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(event) => setSelected(event.target.checked ? items.map((item) => item.id) : [])}
            />
            全选
          </label>
          <span>{selected.length ? `已选 ${selected.length}` : "点击缩略图或标题查看详情"}</span>
        </div>
        <div className="toolbar-actions">
          {(view === "ready" || view === "unset") && (
            <button type="button" disabled={!selected.length} onClick={() => setBatchEditing(true)}>
              <Icon name="pencil-line" />批量编辑
            </button>
          )}
          {canDeleteReadyItems && (
            <button
              className="danger-button"
              type="button"
              disabled={!selected.length || actionBusy}
              onClick={() => setConfirmAction({ kind: "batch-delete", ids: [...selected] })}
            >
              <Icon name="delete-bin-6-line" />批量删除
            </button>
          )}
          {view === "deleted" && (
            <button
              type="button"
              disabled={!selected.length || actionBusy}
              onClick={restoreSelected}
            >
              <Icon name="arrow-go-back-line" />批量恢复
            </button>
          )}
          {view === "deleted" && (
            <button
              className="danger-button"
              type="button"
              disabled={actionBusy || !items.length}
              onClick={() => setConfirmAction({ kind: "empty-trash" })}
            >
              <Icon name="delete-bin-7-line" />{actionBusy && confirmAction?.kind === "empty-trash" ? "正在清空…" : "清空回收站"}
            </button>
          )}
        </div>
      </div>
      <div className="table admin-image-grid admin-scroll-region" ref={gridRef}>
        {items.map((item) => (
          <ImageRow
            key={item.id}
            item={item}
            storageName={storageName}
            checked={selected.includes(item.id)}
            onCheck={(checked) => setSelected((current) => checked ? [...current, item.id] : current.filter((id) => id !== item.id))}
            onDetail={(opener) => {
              detailReturnFocusRef.current = opener;
              setDetail(item);
            }}
            onEdit={() => setEditing(item)}
            onPurge={() => setConfirmAction({ kind: "purge", id: item.id, title: imageDisplayTitle(item) })}
            busy={rowBusy.endsWith(item.id)}
            onDelete={() => void runRowAction(item, "delete")}
            onRestore={() => void runRowAction(item, "restore")}
          />
        ))}
        {listFailed && <QueryErrorState error={listError} onRetry={() => void refetchList()} />}
        {isFetching && !items.length && <p className="muted">加载中</p>}
        {!listFailed && !isFetching && !items.length && <p className="muted">暂无记录</p>}
      </div>
      <OverlayScrollbar targetRef={gridRef} pageEdge />
      <nav className="admin-pagination" aria-label="图片列表分页">
        <button
          type="button"
          disabled={cursorHistory.length === 1 || isFetching}
          onClick={previousPage}
        >上一页</button>
        <span>第 {pageNumber} / {totalPages} 页</span>
        <button
          type="button"
          disabled={!data?.has_next || !data.next_cursor || isFetching}
          onClick={nextPage}
        >下一页</button>
      </nav>
      {detail && (
        <ImageDetailModal
          item={detail}
          onClose={() => setDetail(null)}
          returnFocusRef={detailReturnFocusRef}
          admin
        />
      )}
      {editing && (
        <ImageEditModal
          item={editing}
          themes={themes}
          allTags={allTags}
          authors={authors}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
      {batchEditing && (
        <BatchMetadataModal
          items={selectedItems}
          pageSize={editPageSize}
          themes={themes}
          allTags={allTags}
          authors={authors}
          onClose={() => setBatchEditing(false)}
          onSaved={() => { setBatchEditing(false); refresh(); }}
        />
      )}
      {confirmAction && confirmCopy && (
        <ConfirmDialog
          title={confirmCopy.title}
          description={confirmCopy.description}
          confirmLabel={confirmCopy.label}
          busy={actionBusy}
          onClose={() => setConfirmAction(null)}
          onConfirm={runConfirmedAction}
        />
      )}
    </section>
  );
}

function ImageRow({ item, storageName, checked, busy, onCheck, onDetail, onEdit, onPurge, onDelete, onRestore }: {
  item: ImageItem;
  storageName: (item: { is_link: boolean; storage_slug: string }) => string;
  checked: boolean;
  busy: boolean;
  onCheck: (checked: boolean) => void;
  onDetail: (opener: HTMLElement) => void;
  onEdit: () => void;
  onPurge: () => void;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const handleCardKey = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onDetail(event.currentTarget);
    }
  };
  return (
    <article
      className="row"
      role="button"
      tabIndex={0}
      onClick={(event) => onDetail(event.currentTarget)}
      onKeyDown={handleCardKey}
    >
      <input
        type="checkbox"
        checked={checked}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onCheck(event.target.checked)}
      />
      <div className="thumb-button">
        <ThumbImage src={item.thumb_url} alt="" />
      </div>
      <div className="row-main">
        <strong>{imageDisplayTitle(item)}</strong>
        <span>{formatImageClassification(item)}</span>
      </div>
      <div className="row-actions" onClick={(event) => event.stopPropagation()}>
        {item.status === "deleted" && item.deleted_at && <span className="row-deleted">删除于 {formatDate(item.deleted_at)}</span>}
        {item.status === "ready" && <span className="row-storage"><Icon name="hard-drive-2-line" />{storageName(item)}</span>}
        {item.status === "ready" ? (
          <>
            <button title="编辑" disabled={busy} onClick={onEdit}><Icon name="pencil-line" /></button>
            <button
              className="danger-button"
              title="删除"
              disabled={busy}
              onClick={onDelete}
            >
              <Icon name="delete-bin-6-line" />
            </button>
          </>
        ) : (
          <>
            <button
              title="恢复"
              disabled={busy}
              onClick={onRestore}
            >
              <Icon name="arrow-go-back-line" />
            </button>
            <button className="danger-button" title="永久删除" disabled={busy} onClick={onPurge}>
              <Icon name="delete-bin-7-line" />
            </button>
          </>
        )}
      </div>
    </article>
  );
}
