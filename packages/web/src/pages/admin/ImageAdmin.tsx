import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api/client.js";
import { Icon } from "../../components/icon/Icon.js";
import { ConfirmDialog } from "../../components/feedback/ConfirmDialog.js";
import { PageToast } from "../../components/feedback/PageToast.js";
import { LabeledSwitch } from "../../components/form/LabeledSwitch.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { AdminPagination } from "../../components/navigation/AdminPagination.js";
import {
  adminApiBasePath,
  adminImagePageLimit,
  queryKeys
} from "../../lib/constants.js";
import { errorMessage, formatDate, formatImageClassification, imageDisplayTitle } from "../../lib/ui/formatters.js";
import { useImportVocabulary } from "../../lib/api/import-vocabulary.js";
import { useStorageNameResolver } from "../../lib/api/storage-options.js";
import type { AdminSettings, ImageItem } from "../../lib/types.js";
import { ImageDetailModal } from "../../components/image/ImageDetailModal.js";
import { ThumbImage } from "../../components/image/ThumbImage.js";
import { BatchMetadataModal } from "./BatchMetadataModal.js";
import { ImageEditModal } from "./ImageEditModal.js";
import { Uploader } from "./uploader/Uploader.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { invalidateImageData } from "../../lib/api/query-invalidation.js";
import { useAdminPreference } from "../../hooks/useAdminPreferences.js";

type ConfirmAction =
  | { kind: "batch-delete"; ids: string[] }
  | { kind: "empty-trash" }
  | { kind: "purge"; id: string; title: string };

type ImageAdminView = "ready" | "unset" | "deleted";
type AdminImageListResult = {
  items: ImageItem[];
  total: number;
  has_next: boolean;
  next_cursor: string | null;
};

function adminImageListQuery(view: ImageAdminView, cursor: string, pageSize: number) {
  const params = new URLSearchParams({
    status: view === "deleted" ? "deleted" : "ready",
    limit: String(pageSize)
  });
  // 「无主题」页签只显示未设置主题的正常图片。
  if (view === "unset") params.set("t", "none");
  if (cursor) params.set("cursor", cursor);

  return {
    queryKey: [...queryKeys.adminImages, view, cursor, pageSize] as const,
    queryFn: () => api<AdminImageListResult>(`${adminApiBasePath}/images?${params}`)
  };
}

// 批量恢复每批提交的张数。恢复现在是纯数据库操作（不动文件），但仍分小批依次提交：让进度
// 「恢复中… X/N」能逐批刷新、单请求有界，避免一次性大批量时按钮长时间无响应。
const restoreChunkSize = 10;

export function ImageAdmin() {
  const [searchParams, setSearchParams] = useSearchParams();
  const viewParam = searchParams.get("view");
  const [view, setView] = useState<ImageAdminView>(viewParam === "unset" || viewParam === "deleted" ? viewParam : "ready");
  const [cursorHistory, setCursorHistory] = useState<string[]>([""]);
  const [pageNavigation, setPageNavigation] = useState<"previous" | "next" | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [cardDensity, setCardDensity] = useAdminPreference("image_card_density", "compact");
  const [detail, setDetail] = useState<ImageItem | null>(null);
  const [editing, setEditing] = useState<ImageItem | null>(null);
  const [batchEditing, setBatchEditing] = useState(false);

  const [operationText, setOperationText] = useState("");
  const [toast, setToast] = useState<{ id: number; message: string; kind: "error" | "success" } | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const editReturnFocusRef = useRef<HTMLElement | null>(null);
  const batchEditReturnFocusRef = useRef<HTMLElement | null>(null);
  const toastSequenceRef = useRef(0);
  const pageNavigationSequenceRef = useRef(0);
  const client = useQueryClient();
  const { data: settingsData } = useQuery<{ settings: AdminSettings }>({ queryKey: queryKeys.settings, queryFn: () => api(`${adminApiBasePath}/settings`) });

  const editorDataNeeded = Boolean(editing || batchEditing);
  const { data: vocabulary } = useImportVocabulary(editorDataNeeded);
  const themes = vocabulary?.themes ?? [];
  const allTags = vocabulary?.tags ?? [];
  const authors = vocabulary?.authors ?? [];
  // 列表卡片的「所在存储」展示后端显示名（而非 slug）；从后端列表解析。
  const storageName = useStorageNameResolver();
  const pageSize = settingsData?.settings.admin.image_page_size ?? adminImagePageLimit;
  const editPageSize = settingsData?.settings.upload.list_page_size ?? 20;
  const cursor = cursorHistory.at(-1) ?? "";
  const pageNumber = cursorHistory.length;
  const { data, error: listError, isError: listFailed, isFetching, refetch: refetchList } = useQuery({
    ...adminImageListQuery(view, cursor, pageSize),
    enabled: Boolean(settingsData)
  });
  const showToast = (message: string, kind: "error" | "success") => {
    toastSequenceRef.current += 1;
    setToast({ id: toastSequenceRef.current, message, kind });
  };
  const refresh = async () => {
    pageNavigationSequenceRef.current += 1;
    setPageNavigation(null);
    setSelected([]);
    await invalidateImageData(client);
  };
  const items = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));
  const selectedItems = items.filter((item) => selected.includes(item.id));
  const allSelected = items.length > 0 && selected.length === items.length;
  const operationBusy = actionBusy || busyIds.length > 0;
  const canDeleteReadyItems = view !== "deleted";
  const changeView = (next: typeof view) => {
    if (next === view || operationBusy) return;
    pageNavigationSequenceRef.current += 1;
    setPageNavigation(null);
    gridRef.current?.scrollTo({ top: 0, left: 0 });
    setView(next);
    setCursorHistory([""]);
    setSelected([]);
    setToast(null);

    setSearchParams(next === "ready" ? {} : { view: next }, { replace: true });
  };
  const loadPage = async (
    targetHistory: string[],
    direction: "previous" | "next"
  ) => {
    if (pageNavigation) return;
    const targetCursor = targetHistory.at(-1) ?? "";
    const requestSequence = ++pageNavigationSequenceRef.current;
    setPageNavigation(direction);
    setToast(null);

    try {
      // 当前页及页码保持不动；目标页完整返回并进入查询缓存后，再一次性提交游标。
      await client.fetchQuery(adminImageListQuery(view, targetCursor, pageSize));
      if (requestSequence !== pageNavigationSequenceRef.current) return;
      setSelected([]);
      setCursorHistory(targetHistory);
    } catch (error) {
      if (requestSequence === pageNavigationSequenceRef.current) {
        showToast(`页面加载失败：${errorMessage(error)}`, "error");
      }
    } finally {
      if (requestSequence === pageNavigationSequenceRef.current) {
        setPageNavigation(null);
      }
    }
  };
  const previousPage = () => {
    if (pageNavigation || cursorHistory.length === 1) return;
    void loadPage(cursorHistory.slice(0, -1), "previous");
  };
  const nextPage = () => {
    if (pageNavigation || !data?.next_cursor) return;
    void loadPage([...cursorHistory, data.next_cursor], "next");
  };
  useEffect(() => {
    setSelected([]);
    // 视图和游标页不复用上一页的滚动位置，避免快速切换到回收站时首屏卡片只露出残片。
    gridRef.current?.scrollTo({ top: 0, left: 0 });
  }, [cursor, view]);
  useEffect(() => {
    if (isFetching || !data || pageNumber === 1) return;
    if (data.items.length > 0 && pageNumber <= totalPages) return;

    // 删除、恢复或分类编辑可能让最后一页消失。正常刷新保留当前游标；只有当前页
    // 已经无效时才退回一页，并允许新页结果继续把游标夹紧到最后一个有效页。
    pageNavigationSequenceRef.current += 1;
    setPageNavigation(null);
    setSelected([]);
    setCursorHistory((current) => current.length > 1 ? current.slice(0, -1) : current);
  }, [data, isFetching, pageNumber, totalPages]);
  const runRowAction = async (item: ImageItem, action: "delete" | "restore") => {
    if (operationBusy) return;
    setBusyIds([item.id]);
    setToast(null);
    setOperationText(action === "delete" ? "正在删除图片…" : "正在恢复图片…");
    try {
      await api(`${adminApiBasePath}/images/${item.id}/${action}`, { method: "POST" });
      await refresh();
      showToast(action === "delete" ? "图片已移入回收站" : "图片已恢复", "success");
    } catch (error) {
      showToast(`操作失败：${errorMessage(error)}`, "error");
    } finally {
      setOperationText("");
      setBusyIds([]);
    }
  };
  const runConfirmedAction = async () => {
    if (!confirmAction) return;
    const affectedIds = confirmAction.kind === "batch-delete"
      ? confirmAction.ids
      : confirmAction.kind === "empty-trash"
        ? items.map((item) => item.id)
        : [confirmAction.id];
    setActionBusy(true);
    setBusyIds(affectedIds);
    setToast(null);
    setOperationText(
      confirmAction.kind === "batch-delete"
        ? `正在批量删除 ${confirmAction.ids.length} 张图片…`
        : confirmAction.kind === "empty-trash"
          ? "正在清空回收站…"
          : "正在永久删除图片…"
    );
    try {
      if (confirmAction.kind === "batch-delete") {
        const result = await api<{ deleted: number; ignored: number }>(`${adminApiBasePath}/images/batch-delete`, { method: "POST", body: JSON.stringify({ ids: confirmAction.ids }) });
        showToast(`已删除 ${result.deleted} 张，忽略 ${result.ignored} 张`, result.ignored ? "error" : "success");
      } else if (confirmAction.kind === "empty-trash") {
        const result = await api<{ deleted: number; failed: number }>(`${adminApiBasePath}/images/empty-trash`, { method: "POST" });
        showToast(
          `已永久删除 ${result.deleted} 张图片${result.failed ? `，${result.failed} 张存储删除失败并保留在回收站` : ""}`,
          result.failed ? "error" : "success"
        );
      } else {
        await api(`${adminApiBasePath}/images/${confirmAction.id}/purge`, { method: "POST" });
        showToast(`已永久删除 ${confirmAction.title}`, "success");
      }
      await refresh();
    } catch (error) {
      showToast(`操作失败：${errorMessage(error)}`, "error");
    } finally {
      setActionBusy(false);
      setOperationText("");
      setBusyIds([]);
    }
  };
  // 批量恢复：把选中项切成小批依次提交，每批后更新「恢复中… X/N」进度，全程 actionBusy 禁用按钮，
  // 结束再汇总恢复/忽略数。请求级错误由 catch 处理；出错时也走 refresh，
  // 让已成功恢复的部分如实反映到列表。
  const restoreSelected = async () => {
    const ids = [...selected];
    const total = ids.length;
    if (!total) return;
    setActionBusy(true);
    setBusyIds(ids);
    setToast(null);
    setOperationText(`恢复中… 0 / ${total} 张`);
    let restored = 0;
    let ignored = 0;
    try {
      for (let start = 0; start < total; start += restoreChunkSize) {
        const chunk = ids.slice(start, start + restoreChunkSize);
        const result = await api<{ restored: number; ignored: number }>(
          `${adminApiBasePath}/images/batch-restore`,
          { method: "POST", body: JSON.stringify({ ids: chunk }) }
        );
        restored += result.restored;
        ignored += result.ignored;
        setOperationText(`恢复中… ${Math.min(start + chunk.length, total)} / ${total} 张`);
      }
      showToast(
        `已恢复 ${restored} 张，忽略 ${ignored} 张`,
        ignored ? "error" : "success"
      );
    } catch (error) {
      showToast(`批量恢复失败：${errorMessage(error)}（已恢复 ${restored} 张）`, "error");
    } finally {
      await refresh().catch(() => undefined);
      setActionBusy(false);
      setOperationText("");
      setBusyIds([]);
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
          <p role="status" aria-live="polite" aria-atomic="true">
            {operationText || (
              `第 ${pageNumber} / ${totalPages} 页 · 共 ${data?.total ?? 0} 项 · 本页 ${items.length} 项${
                pageNavigation === "previous" ? " · 正在加载上一页" : pageNavigation === "next" ? " · 正在加载下一页" : isFetching ? " · 加载中" : ""
              }`
            )}
          </p>
        </div>
        <div className="image-admin-head-tools">
          {view === "ready" && <Uploader onDone={refresh} />}
          <div className="segmented">
            <button type="button" className={view === "ready" ? "active" : ""} disabled={operationBusy} onClick={() => changeView("ready")}>
              图库
            </button>
            <button type="button" className={view === "unset" ? "active" : ""} disabled={operationBusy} onClick={() => changeView("unset")}>
              无主题
            </button>
            <button type="button" className={view === "deleted" ? "active" : ""} disabled={operationBusy} onClick={() => changeView("deleted")}>
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
              disabled={operationBusy}
              onChange={(event) => setSelected(event.target.checked ? items.map((item) => item.id) : [])}
            />
            全选
          </label>
          <span>{selected.length ? `已选 ${selected.length}` : "点击缩略图或标题查看详情"}</span>
        </div>
        <div className="toolbar-actions image-list-toolbar-actions">
          <LabeledSwitch
            className="image-card-density-switch"
            checked={cardDensity === "spacious"}
            checkedLabel="宽松"
            uncheckedLabel="紧凑"
            ariaLabel="图片卡片密度"
            onChange={(spacious) => {
              setCardDensity(spacious ? "spacious" : "compact");
            }}
          />
          {(view === "ready" || view === "unset") && (
            <button type="button" disabled={!selected.length || operationBusy} onClick={(event) => {
              batchEditReturnFocusRef.current = event.currentTarget;
              setBatchEditing(true);
            }}>
              <Icon name="pencil-line" />批量编辑
            </button>
          )}
          {view === "deleted" && (
            <button
              type="button"
              disabled={!selected.length || operationBusy}
              onClick={restoreSelected}
            >
              <Icon name="arrow-go-back-line" />批量恢复
            </button>
          )}
          {canDeleteReadyItems && (
            <button
              className="danger-button"
              type="button"
              disabled={!selected.length || operationBusy}
              onClick={() => setConfirmAction({ kind: "batch-delete", ids: [...selected] })}
            >
              <Icon name="delete-bin-6-line" />批量删除
            </button>
          )}
          {view === "deleted" && (
            <button
              className="danger-button"
              type="button"
              disabled={operationBusy || !items.length}
              onClick={() => setConfirmAction({ kind: "empty-trash" })}
            >
              <Icon name="delete-bin-7-line" />{actionBusy && confirmAction?.kind === "empty-trash" ? "正在清空…" : "清空回收站"}
            </button>
          )}
        </div>
      </div>
      <div
        key={`grid:${view}:${cursor}`}
        className="table admin-image-grid admin-scroll-region"
        data-density={cardDensity}
        ref={gridRef}
      >
        {items.map((item) => (
          <AdminImageCard
            key={item.id}
            item={item}
            storageName={storageName}
            checked={selected.includes(item.id)}
            onCheck={(checked) => setSelected((current) => checked ? [...current, item.id] : current.filter((id) => id !== item.id))}
            onDetail={(opener) => {
              detailReturnFocusRef.current = opener;
              setDetail(item);
            }}
            onEdit={(opener) => {
              editReturnFocusRef.current = opener;
              setEditing(item);
            }}
            onPurge={() => setConfirmAction({ kind: "purge", id: item.id, title: imageDisplayTitle(item) })}
            busy={busyIds.includes(item.id)}
            actionsDisabled={operationBusy}
            onDelete={() => void runRowAction(item, "delete")}
            onRestore={() => void runRowAction(item, "restore")}
          />
        ))}
        {listFailed && <QueryErrorState error={listError} onRetry={() => void refetchList()} />}
        {isFetching && !items.length && <p className="muted">加载中</p>}
        {!listFailed && !isFetching && !items.length && <p className="muted">暂无记录</p>}
      </div>
      <OverlayScrollbar key={`scrollbar:${view}:${cursor}`} targetRef={gridRef} pageEdge />
      <AdminPagination
        ariaLabel="图片列表分页"
        page={pageNumber}
        totalPages={totalPages}
        previousDisabled={operationBusy || cursorHistory.length === 1 || isFetching || pageNavigation !== null}
        nextDisabled={operationBusy || !data?.has_next || !data.next_cursor || isFetching || pageNavigation !== null}
        onPrevious={previousPage}
        onNext={nextPage}
      />
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
          onSaved={refresh}
          returnFocusRef={editReturnFocusRef}
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
          onSaved={refresh}
          returnFocusRef={batchEditReturnFocusRef}
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
      {toast && (
        <PageToast
          key={toast.id}
          message={toast.message}
          kind={toast.kind}
          onClose={() => setToast(null)}
        />
      )}
    </section>
  );
}

function AdminImageCard({ item, storageName, checked, busy, actionsDisabled, onCheck, onDetail, onEdit, onPurge, onDelete, onRestore }: {
  item: ImageItem;
  storageName: (item: { is_link: boolean; storage_slug: string }) => string;
  checked: boolean;
  busy: boolean;
  actionsDisabled: boolean;
  onCheck: (checked: boolean) => void;
  onDetail: (opener: HTMLElement) => void;
  onEdit: (opener: HTMLElement) => void;
  onPurge: () => void;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const title = imageDisplayTitle(item);
  const classification = formatImageClassification(item);
  const storage = item.status === "ready" ? storageName(item) : "";
  const deletedAt = item.status === "deleted" && item.deleted_at
    ? `删除于 ${formatDate(item.deleted_at)}`
    : "";

  return (
    <article
      className={`admin-image-card${busy ? " is-busy" : ""}`}
      aria-busy={busy}
    >
      <input
        className="admin-image-card-checkbox"
        type="checkbox"
        checked={checked}
        disabled={busy || actionsDisabled}
        aria-label={`选择图片：${title}`}
        onChange={(event) => onCheck(event.target.checked)}
      />
      <button
        type="button"
        className="admin-image-card-detail"
        disabled={busy}
        aria-label={`查看图片详情：${title}`}
        onClick={(event) => onDetail(event.currentTarget)}
      >
        <span className="admin-image-card-thumb">
          <ThumbImage src={item.thumb_url} alt="" />
        </span>
        <span className="admin-image-card-main">
          <strong title={title}>{title}</strong>
          <span title={classification}>{classification}</span>
          <AdminImageCardMetadata placement="inline" storage={storage} deletedAt={deletedAt} />
        </span>
      </button>
      <footer className="admin-image-card-footer">
        <AdminImageCardMetadata placement="footer" storage={storage} deletedAt={deletedAt} />
        <div className="admin-image-card-actions">
          {item.status === "ready" ? (
            <>
              <button
                type="button"
                title="编辑"
                aria-label={`编辑图片：${title}`}
                disabled={actionsDisabled}
                onClick={(event) => onEdit(event.currentTarget)}
              >
                <Icon name="pencil-line" />
              </button>
              <button
                type="button"
                className="danger-button"
                title="删除"
                aria-label={`删除图片：${title}`}
                disabled={actionsDisabled}
                onClick={onDelete}
              >
                <Icon name="delete-bin-6-line" />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                title="恢复"
                aria-label={`恢复图片：${title}`}
                disabled={actionsDisabled}
                onClick={onRestore}
              >
                <Icon name="arrow-go-back-line" />
              </button>
              <button
                type="button"
                className="danger-button"
                title="永久删除"
                aria-label={`永久删除图片：${title}`}
                disabled={actionsDisabled}
                onClick={onPurge}
              >
                <Icon name="delete-bin-7-line" />
              </button>
            </>
          )}
        </div>
      </footer>
    </article>
  );
}

function AdminImageCardMetadata({ placement, storage, deletedAt }: {
  placement: "inline" | "footer";
  storage: string;
  deletedAt: string;
}) {
  const className = `admin-image-card-meta is-${placement}`;

  if (storage) {
    return (
      <span className={className} title={`存储：${storage}`}>
        <Icon name="hard-drive-2-line" />
        <span>{storage}</span>
      </span>
    );
  }

  if (deletedAt) return <span className={className} title={deletedAt}>{deletedAt}</span>;
  return null;
}
