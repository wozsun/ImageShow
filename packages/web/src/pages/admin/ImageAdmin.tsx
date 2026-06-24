import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { Icon } from "../../components/Icon.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { adminApiBasePath, queryKeys } from "../../lib/constants.js";
import { formatDate, formatImageMeta } from "../../lib/formatters.js";
import { storageBackendLabel } from "../../lib/select-options.js";
import type { AdminSettings, GalleryOptions, ImageItem } from "../../lib/types.js";
import { ImageDetailModal } from "../../components/ImageDetailModal.js";
import { ThumbImage } from "../../components/ThumbImage.js";
import { BatchMetadataModal, ImageEditModal } from "./ImageModals.js";
import { Uploader } from "./Uploader.js";

type ConfirmAction =
  | { kind: "batch-delete"; ids: string[] }
  | { kind: "empty-trash" }
  | { kind: "purge"; id: string; title: string };

export function ImageAdmin() {
  const [view, setView] = useState<"ready" | "unset" | "deleted">("ready");
  const [cursorHistory, setCursorHistory] = useState<string[]>([""]);
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<ImageItem | null>(null);
  const [editing, setEditing] = useState<ImageItem | null>(null);
  const [batchEditing, setBatchEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const client = useQueryClient();
  const { data: settingsData } = useQuery<{ settings: AdminSettings }>({ queryKey: queryKeys.settings, queryFn: () => api(`${adminApiBasePath}/settings`) });
  const { data: galleryOptions } = useQuery<GalleryOptions>({ queryKey: queryKeys.galleryOptions, queryFn: () => api("/api/gallery-options") });
  const themes = galleryOptions?.themes ?? [];
  const pageSize = settingsData?.settings.admin.image_page_size ?? 50;
  const editPageSize = settingsData?.settings.upload.list_page_size ?? 20;
  const cursor = cursorHistory.at(-1) ?? "";
  const pageNumber = cursorHistory.length;
  const listParams = new URLSearchParams({ status: view === "unset" ? "ready" : view, limit: String(pageSize) });
  if (view === "unset") listParams.set("unset", "1");
  if (cursor) listParams.set("cursor", cursor);
  const listPath = `${adminApiBasePath}/images?${listParams}`;
  const { data, isFetching } = useQuery<{ items: ImageItem[]; total: number; has_next: boolean; next_cursor: string | null }>({
    queryKey: [...queryKeys.adminImages, view, cursor, pageSize],
    queryFn: () => api(listPath),
  });
  const refresh = () => {
    setSelected([]);
    setCursorHistory([""]);
    client.invalidateQueries({ queryKey: queryKeys.adminImages });
    client.invalidateQueries({ queryKey: ["public-images"] });
    client.invalidateQueries({ queryKey: queryKeys.galleryOptions });
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
    setNotice("");
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
  const runConfirmedAction = async () => {
    if (!confirmAction) return;
    setActionBusy(true);
    try {
      if (confirmAction.kind === "batch-delete") {
        const result = await api<{ deleted: number; ignored: number }>(`${adminApiBasePath}/images/batch-delete`, { method: "POST", body: JSON.stringify({ ids: confirmAction.ids }) });
        setNotice(`已删除 ${result.deleted} 张，忽略 ${result.ignored} 张`);
      } else if (confirmAction.kind === "empty-trash") {
        setNotice("正在清空回收站，请稍候…");
        const result = await api<{ deleted: number; failed: number }>(`${adminApiBasePath}/images/empty-trash`, { method: "POST" });
        setNotice(`已永久删除 ${result.deleted} 张图片${result.failed ? `，${result.failed} 张存储删除失败并保留在回收站` : ""}`);
      } else {
        await api(`${adminApiBasePath}/images/${confirmAction.id}/purge`, { method: "POST" });
        setNotice(`已永久删除 ${confirmAction.title}`);
      }
      refresh();
    } catch (error) {
      setNotice(`操作失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setActionBusy(false);
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
    <section className="workspace">
      <header className="workspace-head">
        <div>
          <h1>图片</h1>
          <p>第 {pageNumber} / {totalPages} 页 · 共 {data?.total ?? 0} 项 · 本页 {items.length} 项{isFetching ? " · 加载中" : ""}</p>
        </div>
        <div className="segmented">
          <button type="button" className={view === "ready" ? "active" : ""} onClick={() => changeView("ready")}>图库</button>
          <button type="button" className={view === "unset" ? "active" : ""} onClick={() => changeView("unset")}>未设置</button>
          <button type="button" className={view === "deleted" ? "active" : ""} onClick={() => changeView("deleted")}>回收站</button>
        </div>
      </header>
      {view === "ready" && <Uploader onDone={refresh} />}
      {notice && <p className="notice-line">{notice}</p>}
      <div className="toolbar">
        <div className="inline-actions">
          <label className="check-label"><input type="checkbox" checked={allSelected} onChange={(event) => setSelected(event.target.checked ? items.map((item) => item.id) : [])} />全选</label>
          <span>{selected.length ? `已选 ${selected.length}` : "点击缩略图或标题查看详情"}</span>
        </div>
        <div className="toolbar-actions">
          {(view === "ready" || view === "unset") && <button type="button" disabled={!selected.length} onClick={() => setBatchEditing(true)}><Icon name="pencil-line" />批量编辑</button>}
          {canDeleteReadyItems && <button className="danger-button" type="button" disabled={!selected.length || actionBusy} onClick={() => setConfirmAction({ kind: "batch-delete", ids: [...selected] })}><Icon name="delete-bin-6-line" />批量删除</button>}
          {view === "deleted" && <button type="button" disabled={!selected.length} onClick={async () => { const result = await api<{ restored: number; ignored: number; failed: number }>(`${adminApiBasePath}/images/batch-restore`, { method: "POST", body: JSON.stringify({ ids: selected }) }); setNotice(`已恢复 ${result.restored} 张，忽略 ${result.ignored} 张，失败 ${result.failed} 张`); refresh(); }}><Icon name="arrow-go-back-line" />批量恢复</button>}
          {view === "deleted" && <button className="danger-button" type="button" disabled={actionBusy || !items.length} onClick={() => setConfirmAction({ kind: "empty-trash" })}><Icon name="delete-bin-7-line" />{actionBusy && confirmAction?.kind === "empty-trash" ? "正在清空…" : "清空回收站"}</button>}
        </div>
      </div>
      <div className="table admin-image-grid">
        {items.map((item) => (
          <ImageRow
            key={item.id}
            item={item}
            checked={selected.includes(item.id)}
            onCheck={(checked) => setSelected((current) => checked ? [...current, item.id] : current.filter((id) => id !== item.id))}
            onDetail={() => setDetail(item)}
            onEdit={() => setEditing(item)}
            onPurge={() => setConfirmAction({ kind: "purge", id: item.id, title: item.title || item.id })}
            onChanged={refresh}
          />
        ))}
        {isFetching && !items.length && <p className="muted">加载中</p>}
        {!isFetching && !items.length && <p className="muted">暂无记录</p>}
      </div>
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
      {detail && <ImageDetailModal item={detail} onClose={() => setDetail(null)} admin />}
      {editing && <ImageEditModal item={editing} themes={themes} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {batchEditing && <BatchMetadataModal items={selectedItems} pageSize={editPageSize} themes={themes} onClose={() => setBatchEditing(false)} onSaved={() => { setBatchEditing(false); refresh(); }} />}
      {confirmAction && confirmCopy && <ConfirmDialog title={confirmCopy.title} description={confirmCopy.description} confirmLabel={confirmCopy.label} busy={actionBusy} onClose={() => setConfirmAction(null)} onConfirm={runConfirmedAction} />}
    </section>
  );
}

function ImageRow({ item, checked, onCheck, onDetail, onEdit, onPurge, onChanged }: { item: ImageItem; checked: boolean; onCheck: (checked: boolean) => void; onDetail: () => void; onEdit: () => void; onPurge: () => void; onChanged: () => void }) {
  const handleCardKey = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onDetail();
    }
  };
  return (
    <article className="row" role="button" tabIndex={0} onClick={onDetail} onKeyDown={handleCardKey}>
      <input type="checkbox" checked={checked} onClick={(event) => event.stopPropagation()} onChange={(event) => onCheck(event.target.checked)} />
      <div className="thumb-button"><ThumbImage src={item.thumb_url} alt="" /></div>
      <div className="row-main">
        <strong>{item.title || item.id}</strong>
        <span>{formatImageMeta(item)}</span>
      </div>
      <div className="row-actions" onClick={(event) => event.stopPropagation()}>
        {item.status === "deleted" && item.deleted_at && <span className="row-deleted">删除于 {formatDate(item.deleted_at)}</span>}
        {item.status === "ready" && <span className="row-storage"><Icon name="hard-drive-2-line" />{storageBackendLabel(item.storage_backend)}</span>}
        {item.status === "ready" ? (
          <>
            <button title="编辑" onClick={onEdit}><Icon name="pencil-line" /></button>
            <button className="danger-button" title="删除" onClick={async () => { await api(`${adminApiBasePath}/images/${item.id}/delete`, { method: "POST" }); onChanged(); }}><Icon name="delete-bin-6-line" /></button>
          </>
        ) : (
          <><button title="恢复" onClick={async () => { await api(`${adminApiBasePath}/images/${item.id}/restore`, { method: "POST" }); onChanged(); }}><Icon name="arrow-go-back-line" /></button><button className="danger-button" title="永久删除" onClick={onPurge}><Icon name="delete-bin-7-line" /></button></>
        )}
      </div>
    </article>
  );
}
