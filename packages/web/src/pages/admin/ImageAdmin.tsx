import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adminPermissions,
  type AdminImageListResponse
} from "@imageshow/shared/browser";
import { api } from "../../lib/api/client.js";
import { AdminIcon } from "../../components/icon/AdminIcon.js";
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
import { preloadIntentProps } from "../../lib/ui/preload-intent.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { useAdminSettings } from "../../lib/api/admin-settings.js";
import { useImportVocabulary } from "../../lib/api/import-vocabulary.js";
import { useStorageNameResolver } from "../../lib/api/storage-options.js";
import type { ImageItem } from "../../lib/types.js";
import { AdminImageCard } from "./AdminImageCard.js";
import {
  emptyImageAdminFilters,
  ImageAdminFilters,
  type ImageAdminFilterValues
} from "./ImageAdminFilters.js";
import { UploaderLauncher } from "./uploader/UploaderLauncher.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { invalidateImageData } from "../../lib/api/query-invalidation.js";
import { AsyncIntentFence } from "../../lib/async-intent-fence.js";
import { useAdminPreference } from "../../hooks/useAdminPreferences.js";
import { useAdminPermissions } from "../../lib/api/site-data.js";
import { useAdminImageDetailCapability } from "../../hooks/useAdminImageDetailCapability.js";
import { useImageEditorCapability } from "../../hooks/useImageEditorCapability.js";
import {
  mobileViewportMediaQuery,
  useMediaQuery
} from "../../hooks/useMediaQuery.js";
import {
  imageAdminConfirmationCopy,
  useImageAdminOperations,
  type ImageAdminView
} from "./useImageAdminOperations.js";
import {
  adminImagePageBoundaryBuildCount,
  adminImagePageBoundaryBuildLimit,
  adminImagePageRetreatTarget,
  adminImagePageNavigationStatus,
  loadAdminImagePage,
  type AdminImagePageNavigationProgress
} from "./image-page-navigation.js";
import {
  ImageListSelectionController,
  isImageSelectionPreservingTarget
} from "./image-list-selection.js";
import "../../styles/admin/images.css";

const imageRangeSelectionHelpId = "admin-image-range-selection-help";

function adminImageListQuery(
  view: ImageAdminView,
  filters: ImageAdminFilterValues,
  cursor: string,
  pageSize: number
) {
  const params = new URLSearchParams({
    status: view === "deleted" ? "deleted" : "ready",
    limit: String(pageSize)
  });
  // 「无主题」页签只显示未设置主题的正常图片。
  if (view === "unset") params.set("t", "none");
  else if (filters.theme) params.set("t", filters.theme);
  if (filters.device) params.set("d", filters.device);
  if (filters.brightness) params.set("b", filters.brightness);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.author) params.set("a", filters.author);
  if (cursor) params.set("cursor", cursor);

  return {
    queryKey: [...queryKeys.adminImages, params.toString()] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => api<AdminImageListResponse>(`${adminApiBasePath}/images?${params}`, { signal })
  };
}

export function ImageAdmin() {
  const [searchParams, setSearchParams] = useSearchParams();
  const viewParam = searchParams.get("view");
  const routeView: ImageAdminView = viewParam === "unset" || viewParam === "deleted"
    ? viewParam
    : "ready";
  const [view, setView] = useState<ImageAdminView>(routeView);
  const [cursorHistory, setCursorHistory] = useState<string[]>([""]);
  const [pageNavigation, setPageNavigation] = useState<"previous" | "next" | null>(null);
  const [pageNavigationProgress, setPageNavigationProgress] = useState<
    AdminImagePageNavigationProgress | null
  >(null);
  const [filters, setFilters] = useState<ImageAdminFilterValues>(
    emptyImageAdminFilters
  );
  const [cardDensity, setCardDensity] = useAdminPreference("image_card_density");
  const [uploaderPending, setUploaderPending] = useState(false);
  const mobileLayout = useMediaQuery(mobileViewportMediaQuery);
  const permissions = useAdminPermissions();
  const canPurgeImage = permissions.includes(
    adminPermissions.imageTrashPurge
  );
  const canEmptyTrash = permissions.includes(
    adminPermissions.imageTrashEmpty
  );

  const feedbackTarget = useActionFeedbackTarget("image-admin");
  const gridRef = useRef<HTMLDivElement | null>(null);
  const selectionControllerRef = useRef(new ImageListSelectionController());
  const pageNavigationFenceRef = useRef(new AsyncIntentFence());
  const pageNavigationControllerRef = useRef<AbortController | null>(null);
  const client = useQueryClient();
  const { data: settingsData } = useAdminSettings();

  const { data: vocabulary } = useImportVocabulary();
  // 列表卡片的「所在存储」展示后端显示名（而非 slug）；从后端列表解析。
  const storageName = useStorageNameResolver();
  const pageSize = settingsData?.settings.admin.image_page_size ?? adminImagePageLimit;
  const previousPageSizeRef = useRef(pageSize);
  const editPageSize = settingsData?.settings.upload.list_page_size ?? 20;
  const cursor = cursorHistory.at(-1) ?? "";
  const pageNumber = cursorHistory.length;
  const { data, error: listError, isError: listFailed, isFetching, refetch: refetchList } = useQuery({
    ...adminImageListQuery(view, filters, cursor, pageSize),
    enabled: Boolean(settingsData)
  });
  const items = data?.items ?? [];
  const cancelPageNavigation = useCallback(() => {
    pageNavigationFenceRef.current.invalidate();
    const controller = pageNavigationControllerRef.current;
    pageNavigationControllerRef.current = null;
    controller?.abort();
    setPageNavigation(null);
    setPageNavigationProgress(null);
  }, []);
  const invalidateData = useCallback(async () => {
    cancelPageNavigation();
    await invalidateImageData(client);
  }, [cancelPageNavigation, client]);
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
  const detailCapability = useAdminImageDetailCapability<ImageItem>((error) => {
    reportAdminUiError("image_admin.detail_load", error);
    showFeedback("图片详情加载失败，请重新加载页面", "error");
  });
  const detailPending = detailCapability.pendingItemId !== null;
  const editorCapability = useImageEditorCapability({
    onOpenError: (error) => {
      reportAdminUiError("image_admin.editor_load", error);
      showFeedback("图片编辑功能加载失败，请重新加载页面", "error");
    }
  });
  const editorPending = editorCapability.pending !== null;
  const editorConflictBusy = operationBusy || detailPending || uploaderPending;
  const modalOpen = Boolean(
    detailCapability.item || editorCapability.session || confirmAction
  );
  const interfaceBusy = editorConflictBusy || editorPending || modalOpen;
  const clearImageSelection = useCallback(() => {
    selectionControllerRef.current.reset();
    setSelected([]);
  }, [setSelected]);
  const clearSelectionFromPageClick = (
    event: ReactMouseEvent<HTMLElement>
  ) => {
    if (!selected.length || interfaceBusy) return;
    const target = event.target;
    if (
      !(target instanceof Element)
      || !event.currentTarget.contains(target)
      || isImageSelectionPreservingTarget(target)
    ) return;
    clearImageSelection();
  };
  const finishImportBatch = useCallback(() => {
    clearImageSelection();
  }, [clearImageSelection]);
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));
  const canDeleteReadyItems = view !== "deleted";
  useEffect(() => {
    const pageNavigationFence = pageNavigationFenceRef.current;
    pageNavigationFence.mount();
    return () => {
      pageNavigationFence.unmount();
      pageNavigationControllerRef.current?.abort();
      pageNavigationControllerRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (previousPageSizeRef.current === pageSize) return;
    previousPageSizeRef.current = pageSize;
    cancelPageNavigation();
    setCursorHistory([""]);
    clearImageSelection();
    resetTransientState();
    gridRef.current?.scrollTo({ top: 0, left: 0 });
  }, [
    cancelPageNavigation,
    clearImageSelection,
    pageSize,
    resetTransientState
  ]);
  useEffect(() => {
    if (interfaceBusy && pageNavigation) cancelPageNavigation();
  }, [cancelPageNavigation, interfaceBusy, pageNavigation]);
  useEffect(() => {
    if (routeView === view) return;
    cancelPageNavigation();
    setView(routeView);
    setCursorHistory([""]);
    selectionControllerRef.current.reset();
    resetTransientState();
    gridRef.current?.scrollTo({ top: 0, left: 0 });
  }, [cancelPageNavigation, resetTransientState, routeView, view]);
  const changeFilter = (
    key: keyof ImageAdminFilterValues,
    nextValue: string
  ) => {
    if (filters[key] === nextValue || interfaceBusy) return;
    cancelPageNavigation();
    setFilters((current) => ({ ...current, [key]: nextValue }));
    setCursorHistory([""]);
    selectionControllerRef.current.reset();
    resetTransientState();
    gridRef.current?.scrollTo({ top: 0, left: 0 });
  };
  const changeView = (next: typeof view) => {
    if (next === routeView || interfaceBusy) return;
    cancelPageNavigation();
    setSearchParams(next === "ready" ? {} : { view: next }, { replace: true });
  };
  const loadPage = async (targetPage: number) => {
    if (
      interfaceBusy
      || targetPage === pageNumber
      || targetPage < 1
      || targetPage > totalPages
    ) {
      return;
    }
    // 连续导航意图之间可能尚未完成 React 状态提交；ref 是同步所有者，
    // 新意图必须先中止旧补链。
    cancelPageNavigation();
    const boundaryBuilds = adminImagePageBoundaryBuildCount({
      targetPage,
      currentPage: pageNumber,
      cursorHistory
    });
    if (boundaryBuilds > adminImagePageBoundaryBuildLimit) {
      const firstSegmentPage = Math.min(
        totalPages,
        pageNumber + adminImagePageBoundaryBuildLimit
      );
      showFeedback(
        `目标第 ${targetPage} 页尚需建立 ${boundaryBuilds} 个边界；`
        + `单次最多 ${adminImagePageBoundaryBuildLimit} 个，`
        + `请先跳到第 ${firstSegmentPage} 页再继续`,
        "error"
      );
      return;
    }
    const direction = targetPage < pageNumber ? "previous" : "next";
    const pageNavigationFence = pageNavigationFenceRef.current;
    const requestSequence = pageNavigationFence.begin();
    const controller = new AbortController();
    pageNavigationControllerRef.current = controller;
    setPageNavigation(direction);
    setPageNavigationProgress(null);
    setFeedback(null);

    try {
      // 当前页及页码保持不动；目标页完整返回并进入查询缓存后，再一次性提交游标。
      const target = await loadAdminImagePage({
        targetPage,
        currentPage: pageNumber,
        currentPageData: data ?? null,
        cursorHistory,
        signal: controller.signal,
        maxBoundaryBuilds: adminImagePageBoundaryBuildLimit,
        onProgress: (progress) => {
          if (pageNavigationFence.isCurrent(requestSequence)) {
            setPageNavigationProgress(progress);
          }
        },
        load: async (targetCursor) => {
          const query = adminImageListQuery(
            view,
            filters,
            targetCursor,
            pageSize
          );
          const cancelQuery = () => {
            void client.cancelQueries({
              queryKey: query.queryKey,
              exact: true
            }).catch((error) => {
              reportAdminUiError("image_admin.page_navigation_cancel", error);
            });
          };
          controller.signal.addEventListener("abort", cancelQuery, { once: true });
          try {
            controller.signal.throwIfAborted();
            const page = await client.fetchQuery(query);
            controller.signal.throwIfAborted();
            if (!pageNavigationFence.isCurrent(requestSequence)) {
              throw new Error("Image page navigation was superseded");
            }
            return page;
          } finally {
            controller.signal.removeEventListener("abort", cancelQuery);
          }
        }
      });
      if (!pageNavigationFence.isCurrent(requestSequence)) return;
      clearImageSelection();
      setCursorHistory(target.cursorHistory);
    } catch (error) {
      if (pageNavigationFence.isCurrent(requestSequence)) {
        reportAdminUiError("image_admin.page_navigation", error);
        showFeedback("页面加载失败，请稍后重试", "error");
      }
    } finally {
      if (pageNavigationFence.isCurrent(requestSequence)) {
        if (pageNavigationControllerRef.current === controller) {
          pageNavigationControllerRef.current = null;
        }
        setPageNavigation(null);
        setPageNavigationProgress(null);
      }
    }
  };
  useEffect(() => {
    clearImageSelection();
    // 视图和游标页不复用上一页的滚动位置，避免快速切换到回收站时首屏卡片只露出残片。
    gridRef.current?.scrollTo({ top: 0, left: 0 });
  }, [clearImageSelection, cursor, filters, view]);
  useEffect(() => {
    const retreatTarget = adminImagePageRetreatTarget({
      isFetching,
      hasPageData: Boolean(data),
      itemCount: data?.items.length ?? 0,
      currentPage: pageNumber,
      totalPages
    });
    if (retreatTarget === null) return;

    // 删除、恢复或分类编辑可能让当前页消失；直接夹紧到仍可访问的最近页，
    // 避免总页数大幅收缩时逐页查询。
    cancelPageNavigation();
    clearImageSelection();
    setCursorHistory((current) => current.slice(0, retreatTarget));
  }, [
    cancelPageNavigation,
    clearImageSelection,
    data,
    isFetching,
    pageNumber,
    totalPages
  ]);
  useLayoutEffect(() => {
    const reconciled = selectionControllerRef.current.reconcile(
      items.map((item) => item.id),
      selected
    );
    if (
      reconciled.length !== selected.length
      || reconciled.some((id, index) => id !== selected[index])
    ) {
      setSelected(reconciled);
    }
  }, [items, selected]);
  const updateSelection = (
    targetId: string,
    checked: boolean,
    extendRange: boolean
  ) => {
    const pageIds = items.map((item) => item.id);
    setSelected((current) => selectionControllerRef.current.update({
      pageIds,
      selectedIds: current,
      targetId,
      checked,
      extendRange,
      busy: interfaceBusy
    }));
  };
  const preloadBatchEditor = () => editorCapability.preload({
    kind: "batch",
    sources: selectedItems
  });
  const confirmCopy = imageAdminConfirmationCopy(confirmAction);
  const pageNavigationStatus = adminImagePageNavigationStatus(
    pageNavigationProgress
  );
  return (
    <section
      className="workspace workspace-paged"
      onClick={clearSelectionFromPageClick}
    >
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
                pageNavigationStatus
                  ? ` · ${pageNavigationStatus}`
                  : pageNavigation === "previous"
                    ? " · 正在加载上一页"
                    : pageNavigation === "next"
                      ? " · 正在加载下一页"
                      : isFetching ? " · 加载中" : ""
              }`
            )}
          </p>
        </div>
        <div className="image-admin-head-tools">
          <UploaderLauncher
            showTriggers={view === "ready"}
            disabled={operationBusy || detailPending || editorPending}
            onDone={finishImportBatch}
            onLoadError={(error) => {
              reportAdminUiError("image_admin.uploader_load", error);
              showFeedback("上传与导入功能加载失败，请重新加载页面", "error");
            }}
            onPendingChange={(pending) => {
              if (pending) cancelPageNavigation();
              setUploaderPending(pending);
            }}
          />
          <div className="image-admin-view-switch">
            <button type="button" className={view === "ready" ? "active" : ""} disabled={interfaceBusy} onClick={() => changeView("ready")}>
              图库
            </button>
            <button type="button" className={view === "unset" ? "active" : ""} disabled={interfaceBusy} onClick={() => changeView("unset")}>
              无主题
            </button>
            <button type="button" className={view === "deleted" ? "active" : ""} disabled={interfaceBusy} onClick={() => changeView("deleted")}>
              回收站
            </button>
          </div>
        </div>
      </header>
      <div className="image-list-controls">
        <ImageAdminFilters
          value={filters}
          vocabulary={vocabulary}
          view={view}
          mobileLayout={mobileLayout}
          disabled={interfaceBusy}
          onChange={changeFilter}
        />
        <div className="image-list-toolbar">
          <div className="inline-actions image-list-selection">
            <span
              id={imageRangeSelectionHelpId}
              className="image-list-selection-help"
            >
              按住 Shift 点击卡片主体，或按 Shift+Enter，可将图片作为连续选择的区间端点。
            </span>
            <label className="image-list-check-label">
              <input
                id="admin-image-select-all"
                type="checkbox"
                checked={allSelected}
                disabled={interfaceBusy}
                onChange={(event) => {
                  selectionControllerRef.current.reset();
                  setSelected(event.target.checked ? items.map((item) => item.id) : []);
                }}
              />
              全选
            </label>
            <span
              className={`image-list-selection-status${selected.length ? "" : " is-empty"}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {selected.length ? `已选 ${selected.length}` : "未选择图片"}
            </span>
          </div>
          <div className="image-list-toolbar-actions">
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
            <div className="image-list-batch-actions">
              {(view === "ready" || view === "unset") && (
                <button
                  type="button"
                  disabled={
                    !selected.length
                    || editorConflictBusy
                    || editorCapability.pending?.kind === "batch"
                  }
                  aria-busy={
                    editorCapability.pending?.kind === "batch" || undefined
                  }
                   {...preloadIntentProps(preloadBatchEditor)}
                   onClick={(event) => {
                     cancelPageNavigation();
                     void editorCapability.open({
                      kind: "batch",
                      sources: selectedItems
                    }, event.currentTarget);
                  }}
                >
                  <AdminIcon name="pencil-line" />批量编辑
                </button>
              )}
              {view === "deleted" && (
                <button
                  type="button"
                  disabled={!selected.length || interfaceBusy}
                  onClick={() => {
                    cancelPageNavigation();
                    void restoreSelected();
                  }}
                >
                  <AdminIcon name="arrow-go-back-line" />批量恢复
                </button>
              )}
              {canDeleteReadyItems && (
                <button
                  className="danger-button"
                  type="button"
                  disabled={!selected.length || interfaceBusy}
                  onClick={() => {
                    cancelPageNavigation();
                    setConfirmAction({ kind: "batch-delete", ids: [...selected] });
                  }}
                >
                  <AdminIcon name="delete-bin-6-line" />批量删除
                </button>
              )}
              {view === "deleted" && canEmptyTrash && (
                <button
                  className="danger-button"
                  type="button"
                  disabled={interfaceBusy || (!selected.length && !items.length)}
                  onClick={() => {
                    cancelPageNavigation();
                    setConfirmAction(
                      selected.length
                        ? { kind: "purge-selected", ids: [...selected] }
                        : { kind: "empty-trash" }
                    );
                  }}
                >
                  <AdminIcon name="delete-bin-7-line" />
                  <StableButtonLabel
                    idle={selected.length ? "删除已选图" : "清空回收站"}
                    busyText={confirmAction?.kind === "purge-selected" ? "正在删除" : "正在清空"}
                    busy={actionBusy && (
                      confirmAction?.kind === "purge-selected"
                      || confirmAction?.kind === "empty-trash"
                    )}
                  />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      <div
        key={`grid:${view}:${cursor}`}
        className="admin-scroll-region"
        ref={gridRef}
      >
        <div className="admin-image-grid" data-density={cardDensity}>
          {items.map((item) => (
            <AdminImageCard
              key={item.id}
              item={item}
              storageName={storageName}
              checked={selected.includes(item.id)}
              detailDisabled={operationBusy || uploaderPending || editorPending}
              detailPending={detailCapability.pendingItemId === item.id}
              onPreloadDetail={detailCapability.preload}
              onCheck={(checked, extendRange) => updateSelection(
                item.id,
                checked,
                extendRange
              )}
              onSelectRange={() => updateSelection(item.id, true, true)}
              rangeSelectionHelpId={imageRangeSelectionHelpId}
              onDetail={(opener) => {
                cancelPageNavigation();
                void detailCapability.open(item, opener);
              }}
              editDisabled={editorConflictBusy}
              editPending={
                editorCapability.pending?.kind === "single"
                && editorCapability.pending.itemIds[0] === item.id
              }
              onPreloadEdit={() => editorCapability.preload({
                kind: "single",
                sources: [item]
              })}
              onEdit={(opener) => {
                cancelPageNavigation();
                void editorCapability.open({
                  kind: "single",
                  sources: [item]
                }, opener);
              }}
              canPurge={canPurgeImage}
              onPurge={() => {
                cancelPageNavigation();
                setConfirmAction({
                  kind: "purge",
                  id: item.id,
                  title: imageDisplayTitle(item)
                });
              }}
              busy={busyIds.includes(item.id)}
              actionsDisabled={interfaceBusy}
              onDelete={() => {
                cancelPageNavigation();
                void runRowAction(item, "delete");
              }}
              onRestore={() => {
                cancelPageNavigation();
                void runRowAction(item, "restore");
              }}
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
        disabled={interfaceBusy || isFetching || pageNavigation !== null}
        nextDisabled={!data?.next_cursor}
        onPageChange={(targetPage) => void loadPage(targetPage)}
      />
      {detailCapability.item && detailCapability.Modal && (
        <detailCapability.Modal
          item={detailCapability.item}
          onClose={detailCapability.close}
          onDeleted={() => showFeedback("图片已移入回收站", "success")}
          returnFocusRef={detailCapability.returnFocusRef}
          storageLabel={storageName(detailCapability.item)}
          admin
        />
      )}
      {editorCapability.session && (
        <editorCapability.session.module.ImageMetadataEditorDialog
          mode={editorCapability.session.kind === "single"
            ? {
                kind: "single",
                item: editorCapability.session.items[0],
                onDeleted: async () => {
                  await refresh();
                  showFeedback("图片已移入回收站", "success");
                }
              }
            : {
                kind: "batch",
                items: editorCapability.session.items,
                pageSize: editPageSize
              }}
          themes={editorCapability.session.vocabulary.themes}
          allTags={editorCapability.session.vocabulary.tags}
          authors={editorCapability.session.vocabulary.authors}
          onClose={editorCapability.close}
          onSaved={refresh}
          onStorageMigrationSucceeded={(message) => showFeedback(message, "success")}
          returnFocusRef={editorCapability.returnFocusRef}
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
