import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api/client.js";
import { Icon } from "../../components/icon/Icon.js";
import { StableButtonLabel } from "../../components/data-display/StableButtonLabel.js";
import { ConfirmDialog } from "../../components/feedback/ConfirmDialog.js";
import {
  ActionFeedbackOutlet,
  ActionFeedbackRegion,
  useActionFeedbackTarget
} from "../../components/feedback/ActionFeedbackRegion.js";
import { LabeledSwitch } from "../../components/form/LabeledSwitch.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { AdminPagination } from "../../components/navigation/AdminPagination.js";
import {
  adminApiBasePath,
  adminImagePageLimit
} from "../../lib/constants.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import { imageDisplayTitle } from "../../lib/ui/formatters.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { useImportVocabulary } from "../../lib/api/import-vocabulary.js";
import { useStorageNameResolver } from "../../lib/api/storage-options.js";
import type { AdminSettings, ImageItem } from "../../lib/types.js";
import type { AdminImageListResponse } from "@imageshow/shared/browser";
import { ImageDetailModal } from "../../components/image/ImageDetailModal.js";
import { AdminImageCard } from "./AdminImageCard.js";
import { BatchMetadataModal } from "./BatchMetadataModal.js";
import { ImageEditModal } from "./ImageEditModal.js";
import { Uploader } from "./uploader/Uploader.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { invalidateImageData } from "../../lib/api/query-invalidation.js";
import { useAdminPreference } from "../../hooks/useAdminPreferences.js";
import {
  mobileViewportMediaQuery,
  useMediaQuery
} from "../../hooks/useMediaQuery.js";
import {
  imageAdminConfirmationCopy,
  useImageAdminOperations,
  type ImageAdminView
} from "./useImageAdminOperations.js";
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
    queryFn: ({ signal }: { signal: AbortSignal }) => api<AdminImageListResponse>(`${adminApiBasePath}/images?${params}`, { signal })
  };
}

export function ImageAdmin() {
  const [searchParams, setSearchParams] = useSearchParams();
  const viewParam = searchParams.get("view");
  const [view, setView] = useState<ImageAdminView>(viewParam === "unset" || viewParam === "deleted" ? viewParam : "ready");
  const [cursorHistory, setCursorHistory] = useState<string[]>([""]);
  const [pageNavigation, setPageNavigation] = useState<"previous" | "next" | null>(null);
  const [cardDensity, setCardDensity] = useAdminPreference("image_card_density", "compact");
  const [detail, setDetail] = useState<ImageItem | null>(null);
  const [editing, setEditing] = useState<ImageItem | null>(null);
  const [batchEditing, setBatchEditing] = useState(false);
  const mobileLayout = useMediaQuery(mobileViewportMediaQuery);

  const feedbackTarget = useActionFeedbackTarget("image-admin");
  const gridRef = useRef<HTMLDivElement | null>(null);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const editReturnFocusRef = useRef<HTMLElement | null>(null);
  const batchEditReturnFocusRef = useRef<HTMLElement | null>(null);
  const pageNavigationSequenceRef = useRef(0);
  const client = useQueryClient();
  const { data: settingsData } = useQuery<{ settings: AdminSettings }>({ queryKey: queryKeys.settings, queryFn: ({ signal }) => api(`${adminApiBasePath}/settings`, { signal }) });

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
  const items = data?.items ?? [];
  const invalidateData = useCallback(async () => {
    pageNavigationSequenceRef.current += 1;
    setPageNavigation(null);
    await invalidateImageData(client);
  }, [client]);
  const {
    selected,
    setSelected,
    selectedItems,
    allSelected,
    operationText,
    feedback,
    setFeedback,
    showFeedback,
    confirmAction,
    setConfirmAction,
    actionBusy,
    busyIds,
    operationBusy,
    refresh,
    resetTransientState,
    runRowAction,
    runConfirmedAction,
    restoreSelected
  } = useImageAdminOperations({ items, invalidateData });
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));
  const canDeleteReadyItems = view !== "deleted";
  const changeView = (next: typeof view) => {
    if (next === view || operationBusy) return;
    pageNavigationSequenceRef.current += 1;
    setPageNavigation(null);
    gridRef.current?.scrollTo({ top: 0, left: 0 });
    setView(next);
    setCursorHistory([""]);
    resetTransientState();

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
    setFeedback(null);

    try {
      // 当前页及页码保持不动；目标页完整返回并进入查询缓存后，再一次性提交游标。
      await client.fetchQuery(adminImageListQuery(view, targetCursor, pageSize));
      if (requestSequence !== pageNavigationSequenceRef.current) return;
      setSelected([]);
      setCursorHistory(targetHistory);
    } catch (error) {
      if (requestSequence === pageNavigationSequenceRef.current) {
        reportAdminUiError("image_admin.page_navigation", error);
        showFeedback("页面加载失败，请稍后重试", "error");
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
  const confirmCopy = imageAdminConfirmationCopy(confirmAction);
  return (
    <section className="workspace workspace-paged">
      <header className="workspace-head image-admin-head">
        <div className="image-admin-head-copy">
          <div className="image-admin-title-row">
            <h1>图片</h1>
            {mobileLayout && (
              <ActionFeedbackRegion
                className="image-admin-feedback-region"
                target={feedbackTarget}
                variant="page"
              />
            )}
          </div>
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
      <div className="toolbar image-list-toolbar">
        <div className="inline-actions">
          <label className="check-label">
            <input
              id="admin-image-select-all"
              type="checkbox"
              checked={allSelected}
              disabled={operationBusy}
              onChange={(event) => setSelected(event.target.checked ? items.map((item) => item.id) : [])}
            />
            全选
          </label>
          {selected.length > 0 && <span>已选 {selected.length}</span>}
        </div>
        <div className="toolbar-actions image-list-toolbar-actions">
          {!mobileLayout && (
            <ActionFeedbackRegion
              className="image-admin-feedback-region"
              target={feedbackTarget}
              variant="page"
            />
          )}
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
              <Icon name="delete-bin-7-line" />
              <StableButtonLabel
                idle="清空回收站"
                busyText="正在清空"
                busy={actionBusy && confirmAction?.kind === "empty-trash"}
              />
            </button>
          )}
        </div>
      </div>
      <div
        key={`grid:${view}:${cursor}`}
        className="admin-scroll-region"
        ref={gridRef}
      >
        <div className="table admin-image-grid" data-density={cardDensity}>
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
          {listFailed && <QueryErrorState error={listError} onRetry={() => void refetchList()} reportContext="image_admin.list_load" />}
          {isFetching && !items.length && <p className="muted">加载中</p>}
          {!listFailed && !isFetching && !items.length && <p className="muted">暂无记录</p>}
        </div>
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
      {feedback && (
        <ActionFeedbackOutlet
          feedback={feedback}
          target={feedbackTarget}
          onClose={() => setFeedback(null)}
        />
      )}
    </section>
  );
}
