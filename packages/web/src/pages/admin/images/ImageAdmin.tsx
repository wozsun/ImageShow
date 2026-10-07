import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  adminPermissions,
  type AdminImageSort,
  type AdminSettings,
  type AdminImageListItemDto,
  type EditableImageSnapshotDto
} from "@imageshow/shared/browser";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { StableButtonLabel } from "../../../components/data-display/StableButtonLabel.js";
import { TwoStepConfirmButton } from "../../../components/actions/TwoStepConfirmButton.js";
import { ConfirmDialog } from "../../../components/dialog/ConfirmDialog.js";
import {
  ActionFeedbackOutlet,
  ActionFeedbackRegion,
  useActionFeedbackTarget
} from "../../../components/feedback/ActionFeedbackRegion.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import { AdminPagination } from "../../../components/navigation/AdminPagination.js";
import { preloadIntentProps } from "../../../lib/ui/preload-intent.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import { AdminSettingsBoundary } from "../../../components/feedback/AdminSettingsBoundary.js";
import { useIngestionVocabulary } from "../../../lib/api/ingestion-vocabulary.js";
import { useStorageNameResolver } from "../../../lib/api/storage-options.js";
import { createPageLifetimeModuleLoader } from "../../../lib/page-lifetime-module-loader.js";
import { AdminImageCard } from "./AdminImageCard.js";
import {
  emptyImageAdminFilters,
  ImageAdminFilters,
  type ImageAdminFilterValues
} from "./ImageAdminFilters.js";
import { IngestionLauncher } from "../ingestion/IngestionLauncher.js";
import { QueryErrorState } from "../../../components/feedback/QueryErrorState.js";
import {
  invalidateImageData,
  invalidateImageDataAfterAdminListMutation,
  invalidateImageDataAfterMetadataSave
} from "../../../lib/api/query-invalidation.js";
import { useAdminPermissions } from "../../../hooks/useAuthSession.js";
import { useAdminPreference } from "../../../hooks/useAdminPreferences.js";
import { useAdminImageDetailCapability } from "../../../components/image/useAdminImageDetailCapability.js";
import { useImageEditorCapability } from "../../../components/image/editor/useImageEditorCapability.js";
import {
  loadImageEditorCapabilityModule,
  type ImageEditorIntent,
  type ImageMetadataSaveCommit
} from "../../../components/image/editor/image-editor-capability-loader.js";
import {
  mobileViewportMediaQuery,
  useMediaQuery
} from "../../../hooks/useMediaQuery.js";
import { useWorkspaceToolbarCollapse } from "../../../hooks/useWorkspaceToolbarCollapse.js";
import { usePageScrollLock } from "../../../hooks/usePageScrollLock.js";
import { WorkspaceToolbarScrollbar } from "../../../components/layout/WorkspaceToolbarScrollbar.js";
import { WorkspaceToolbar } from "../../../components/layout/WorkspaceToolbar.js";
import { workspaceScrollContainer } from "../../../lib/ui/workspace-scroll.js";
import {
  imageAdminConfirmationCopy,
  useImageAdminOperations,
  type ImageAdminView
} from "./useImageAdminOperations.js";
import { useImageAdminSelection } from "./useImageAdminSelection.js";
import { useImageAdminPageNavigation } from "./useImageAdminPageNavigation.js";
import { imageAdminPaginationScopeKey } from "./image-admin-list-query.js";
import "../../../styles/admin/images.css";

const imageRangeSelectionHelpId = "admin-image-range-selection-help";

type ImageIdInputDialogModule = typeof import("./ImageIdInputDialog.js");

const loadImageIdInputDialog = createPageLifetimeModuleLoader<ImageIdInputDialogModule>(
  () => import("./ImageIdInputDialog.js")
);
// 未勾选时「编辑图片」「删除图片」先输入 ID，再进入编辑弹窗；两段一并预取。
const preloadImageIdInput = () => {
  void loadImageIdInputDialog().catch(() => undefined);
  void loadImageEditorCapabilityModule().catch(() => undefined);
};

type ImageIdInputSession = {
  intent: ImageEditorIntent;
  opener: HTMLButtonElement;
  Dialog: ImageIdInputDialogModule["ImageIdInputDialog"];
};

export function ImageAdmin() {
  return (
    <AdminSettingsBoundary>
      {(settings) => <ImageAdminContent settings={settings} />}
    </AdminSettingsBoundary>
  );
}

function ImageAdminContent({ settings }: { settings: AdminSettings }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const viewParam = searchParams.get("view");
  const routeView: ImageAdminView = viewParam === "deleted" ? viewParam : "ready";
  const [view, setView] = useState<ImageAdminView>(routeView);
  const [filters, setFilters] = useState<ImageAdminFilterValues>(emptyImageAdminFilters);
  const [preferredSortBy, setPreferredSortBy] = useAdminPreference("image_sort_by");
  const [preferredOrder, setPreferredOrder] = useAdminPreference("image_sort_order");
  const [thumbnailFit, setThumbnailFit] = useAdminPreference("image_thumbnail_fit");
  // Account preferences seed each visit; other windows must not reorder an active list.
  const [sort, setSort] = useState<AdminImageSort>(() => ({
    sort_by: preferredSortBy,
    order: preferredOrder
  }));
  const [batchTrashPending, setBatchTrashPending] = useState(false);
  const [idInput, setIdInput] = useState<ImageIdInputSession | null>(null);
  const [idInputPending, setIdInputPending] = useState(false);
  const idInputOpenerRef = useRef<HTMLButtonElement | null>(null);
  const failedIdInputFocusRef = useRef<HTMLButtonElement | null>(null);
  const mobileLayout = useMediaQuery(mobileViewportMediaQuery);
  const permissions = useAdminPermissions();
  const canPurgeImage = permissions.includes(adminPermissions.imageTrashPurge);

  const feedbackTarget = useActionFeedbackTarget("image-admin");
  const workspaceToolbarRef = useWorkspaceToolbarCollapse();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const frozenBatchTrashIdsRef = useRef<string[]>([]);
  const client = useQueryClient();

  const { data: vocabulary } = useIngestionVocabulary();
  // 列表卡片的「所在存储」展示后端显示名（而非 slug）；从后端列表解析。
  const storageName = useStorageNameResolver();
  const pageSize = settings.admin.image_page_size;
  const editPageSize = settings.ingestion.list_page_size;
  const navigation = useImageAdminPageNavigation({
    view,
    filters,
    pageSize,
    sort
  });
  const {
    items,
    hasCurrentPageData,
    total,
    error: listError,
    isError: listFailed,
    isFetching,
    refetch: refetchList,
    scopeKey,
    pageNumber,
    totalPages
  } = navigation;
  const selection = useImageAdminSelection(items);
  const { selected, selectedItems, allSelected } = selection;
  const invalidateData = useCallback(async () => {
    await invalidateImageDataAfterAdminListMutation(client);
  }, [client]);
  const refreshAfterEditorSave = useCallback(
    async (commit?: ImageMetadataSaveCommit) => {
      selection.clear();
      if (!commit) {
        await invalidateImageData(client);
        return;
      }
      await invalidateImageDataAfterMetadataSave(
        client,
        commit.updates,
        commit.authoritativeItems
      );
    },
    [client, selection.clear]
  );
  const {
    operationText,
    feedback,
    setFeedback,
    showFeedback,
    confirmAction,
    confirmError,
    setConfirmAction,
    actionBusy,
    busyIds,
    operationBusy,
    resetTransientState,
    runConfirmedAction,
    trash,
    restore
  } = useImageAdminOperations({
    items,
    clearSelection: selection.clear,
    invalidateData
  });
  const detailCapability = useAdminImageDetailCapability<AdminImageListItemDto>((error) => {
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
  // ID 弹窗模块加载期间沿用上传 / 导入的做法锁住页面根节点：按钮外观不变，指针、键盘、焦点与滚动
  // 一并隔离，弹窗挂载后由其自身的锁接替；加载失败时把焦点还给入口按钮。
  usePageScrollLock(idInputPending);
  useLayoutEffect(() => {
    if (idInputPending) return;
    const target = failedIdInputFocusRef.current;
    failedIdInputFocusRef.current = null;
    if (target?.isConnected
      && !target.disabled
      && !target.closest("[inert]")) target.focus();
  }, [idInputPending]);
  const editorConflictBusy = operationBusy || detailPending;
  const modalOpen = Boolean(
    detailCapability.item
    || editorCapability.session
    || confirmAction
    || idInput
  );
  const interfaceBusy = editorConflictBusy || editorPending || modalOpen;
  // 按 ID 指定图片的入口不随弹窗打开而禁用：弹窗期间页面已 inert，关闭时焦点要能还给按钮。
  const idInputEntryBusy = editorConflictBusy || editorPending;
  const clearImageSelection = selection.clear;
  const finishIngestionBatch = selection.clear;
  const canTrashReadyItems = view !== "deleted";
  const batchTrashDisabled =
    !canTrashReadyItems
    || !selected.length
    || interfaceBusy
    || batchTrashPending;
  useEffect(() => {
    if (routeView === view) return;
    setView(routeView);
    clearImageSelection();
    resetTransientState();
    workspaceScrollContainer(gridRef.current)?.scrollTo({ top: 0, left: 0 });
  }, [
    clearImageSelection,
    resetTransientState,
    routeView,
    view
  ]);
  const applyFilters = (nextFilters: ImageAdminFilterValues) => {
    if (
      interfaceBusy ||
      (Object.keys(filters) as Array<keyof ImageAdminFilterValues>).every(
        (key) => filters[key] === nextFilters[key]
      )
    )
      return;
    const unchangedQuery =
      imageAdminPaginationScopeKey(view, filters, pageSize, sort) ===
      imageAdminPaginationScopeKey(view, nextFilters, pageSize, sort);
    setFilters(nextFilters);
    if (unchangedQuery) return;
    navigation.resetPage();
    clearImageSelection();
    resetTransientState();
    workspaceScrollContainer(gridRef.current)?.scrollTo({ top: 0, left: 0 });
  };
  const changeFilter = (
    key: keyof ImageAdminFilterValues,
    nextValue: string
  ) => {
    applyFilters({ ...filters, [key]: nextValue });
  };
  const clearFilters = () => {
    applyFilters({ ...emptyImageAdminFilters });
  };
  const changeSort = (next: AdminImageSort) => {
    if (interfaceBusy) return;
    navigation.resetPage();
    setSort(next);
    if (next.sort_by !== sort.sort_by) setPreferredSortBy(next.sort_by);
    if (next.order !== sort.order) setPreferredOrder(next.order);
    clearImageSelection();
    resetTransientState();
    workspaceScrollContainer(gridRef.current)?.scrollTo({ top: 0, left: 0 });
  };
  const changeView = (next: typeof view) => {
    if (next === routeView || interfaceBusy) return;
    setSearchParams(next === "ready" ? {} : { view: next }, { replace: true });
  };
  const loadPage = (targetPage: number) => {
    setFeedback(null);
    navigation.loadPage(targetPage, interfaceBusy);
  };
  useEffect(() => {
    clearImageSelection();
    // 每个数字页与筛选 scope 都从顶部开始，避免首屏卡片只露出残片。
    workspaceScrollContainer(gridRef.current)?.scrollTo({ top: 0, left: 0 });
  }, [clearImageSelection, pageNumber, scopeKey]);
  const preloadBatchEditor = () =>
    editorCapability.preload({
      sources: selectedItems
    });
  const openImageIdInput = (intent: ImageEditorIntent, opener: HTMLButtonElement) => {
    setIdInputPending(true);
    void loadImageIdInputDialog().then(
      (module) => {
        if (!opener.isConnected) return;
        idInputOpenerRef.current = opener;
        setIdInput({ intent, opener, Dialog: module.ImageIdInputDialog });
      },
      (error: unknown) => {
        failedIdInputFocusRef.current = opener;
        reportAdminUiError("image_admin.id_input_load", error);
        showFeedback("按 ID 指定图片功能加载失败，请重新加载页面", "error");
      }
    ).finally(() => setIdInputPending(false));
  };
  // ID 弹窗保持到编辑弹窗就绪，二者在同一次渲染中交接，避免中间露出页面。
  const openEditorForImageIds = async (items: EditableImageSnapshotDto[]) => {
    if (!idInput) return "interrupted" as const;
    const { intent, opener } = idInput;
    return editorCapability.open(
      { sources: items, intent, fromDialog: true },
      opener,
      () => {
        setIdInput(null);
      }
    );
  };
  const selectedEditorPending = Boolean(
    editorCapability.pending &&
    editorCapability.pending.itemIds.length === selectedItems.length &&
    selectedItems.every((item, index) => editorCapability.pending?.itemIds[index] === item.id)
  );
  const confirmCopy = imageAdminConfirmationCopy(confirmAction);
  const sortFieldLabel = sort.sort_by === "image_time" ? "图片" : "入库";
  const nextSortFieldLabel = sort.sort_by === "image_time" ? "入库" : "图片";
  const sortOrderLabel = sort.order === "latest" ? "最新" : "最旧";
  const nextSortOrderLabel = sort.order === "latest" ? "最旧" : "最新";
  const thumbnailFitLabel = thumbnailFit === "cover" ? "填充" : "完整";
  const thumbnailFitHelp = thumbnailFit === "cover"
    ? "缩略图填充显示；点击完整显示，保留比例且不裁切"
    : "缩略图完整显示；点击填充显示，铺满图片框";
  const pageStatusSuffix = isFetching
    ? " · 加载中"
    : hasCurrentPageData
      ? ` · 本页 ${items.length} 项`
      : "";
  // 窄屏切换放在标题行，桌面留在工具区；两处共用同一组按钮。
  const viewSwitch = (
    <div className="image-admin-view-switch">
      <button
        type="button"
        className={view === "ready" ? "active" : ""}
        disabled={interfaceBusy}
        onClick={() => changeView("ready")}
      >
        图库
      </button>
      <button
        type="button"
        className={view === "deleted" ? "active" : ""}
        disabled={interfaceBusy}
        onClick={() => changeView("deleted")}
      >
        回收站
      </button>
    </div>
  );
  return (
    <section
      ref={workspaceToolbarRef}
      className="workspace workspace-paged workspace-has-toolbar"
      onClick={(event) => selection.clearFromPageClick(event, interfaceBusy)}
    >
      <header className="workspace-head image-admin-head">
        <div className="image-admin-head-copy" data-workspace-pinned="">
          <h1>图片</h1>
          {mobileLayout && viewSwitch}
          <p role="status">
            {operationText ||
              `第 ${pageNumber} / ${totalPages} 页 · 共 ${total} 项${pageStatusSuffix}`}
          </p>
          <ActionFeedbackRegion
            className="image-admin-feedback-region"
            target={feedbackTarget}
          />
        </div>
        <WorkspaceToolbar className="image-admin-toolbar">
          <div className="image-admin-head-tools">
            <IngestionLauncher
              settings={settings}
              showTriggers={view === "ready"}
              disabled={operationBusy || detailPending || editorPending}
              onDone={finishIngestionBatch}
              onLoadError={(error) => {
                reportAdminUiError("image_admin.ingestion_load", error);
                showFeedback("上传与导入功能加载失败，请重新加载页面", "error");
              }}
            />
            {!mobileLayout && viewSwitch}
          </div>
          <div className="image-list-controls">
            <ImageAdminFilters
              value={filters}
              vocabulary={vocabulary}
              mobileLayout={mobileLayout}
              disabled={interfaceBusy}
              onChange={changeFilter}
              onClear={clearFilters}
            />
            <div className="image-list-toolbar">
              <div className="inline-actions image-list-selection">
                <span id={imageRangeSelectionHelpId} className="image-list-selection-help">
                  按住 Shift 点击卡片主体，或按 Shift+Enter，可将图片作为连续选择的区间端点。
                </span>
                <label className="image-list-check-label">
                  <input
                    id="admin-image-select-all"
                    type="checkbox"
                    checked={allSelected}
                    disabled={interfaceBusy}
                    onChange={(event) => selection.selectAll(
                      event.target.checked,
                      interfaceBusy
                    )}
                  />
                  全选
                </label>
                <span
                  className={`image-list-selection-status${selected.length ? "" : " is-empty"}`}
                  role="status"
                >
                  {selected.length ? `已选 ${selected.length}` : "未选择图片"}
                </span>
              </div>
              <div className="image-list-toolbar-actions">
                <div className="image-list-view-controls" role="group" aria-label="图片列表排序与缩略图显示">
                  <button
                    type="button"
                    className="state-toggle-button"
                    data-shifted={sort.sort_by === "created_at"}
                    disabled={interfaceBusy}
                    aria-label={`按${sortFieldLabel}时间排序；点击切换为${nextSortFieldLabel}时间`}
                    title={`按${sortFieldLabel}时间排序；点击切换为${nextSortFieldLabel}时间`}
                    onClick={() =>
                      changeSort({
                        ...sort,
                        sort_by: sort.sort_by === "image_time" ? "created_at" : "image_time"
                      })
                    }
                  >
                    <span className="state-toggle-label">{sortFieldLabel}</span>
                    <span className="state-toggle-thumb" aria-hidden="true" />
                  </button>
                  <span className="image-list-view-divider" aria-hidden="true" />
                  <button
                    type="button"
                    className="state-toggle-button"
                    data-shifted={sort.order === "oldest"}
                    disabled={interfaceBusy}
                    aria-label={`${sortOrderLabel}优先；点击切换为${nextSortOrderLabel}优先`}
                    title={`${sortOrderLabel}优先；点击切换为${nextSortOrderLabel}优先`}
                    onClick={() =>
                      changeSort({
                        ...sort,
                        order: sort.order === "latest" ? "oldest" : "latest"
                      })
                    }
                  >
                    <span className="state-toggle-label">{sortOrderLabel}</span>
                    <span className="state-toggle-thumb" aria-hidden="true" />
                  </button>
                  <span className="image-list-view-divider" aria-hidden="true" />
                  <button
                    type="button"
                    className="state-toggle-button"
                    data-shifted={thumbnailFit === "contain"}
                    disabled={interfaceBusy}
                    aria-label={thumbnailFitHelp}
                    aria-pressed={thumbnailFit === "contain"}
                    title={thumbnailFitHelp}
                    onClick={() => setThumbnailFit(thumbnailFit === "cover" ? "contain" : "cover")}
                  >
                    <span className="state-toggle-label">{thumbnailFitLabel}</span>
                    <span className="state-toggle-thumb" aria-hidden="true" />
                  </button>
                </div>
                <div className="image-list-batch-actions">
                  {view !== "deleted" && (
                    <button
                      type="button"
                      disabled={selected.length
                        ? editorConflictBusy || selectedEditorPending
                        : idInputEntryBusy}
                      aria-busy={selectedEditorPending || undefined}
                      {...preloadIntentProps(selected.length
                        ? preloadBatchEditor
                        : preloadImageIdInput)}
                      onClick={(event) => {
                        if (!selected.length) {
                          openImageIdInput("edit", event.currentTarget);
                          return;
                        }
                        void editorCapability.open(
                          {
                            sources: selectedItems
                          },
                          event.currentTarget
                        );
                      }}
                    >
                      <AdminIcon name="pencil-line" />
                      {selected.length ? "批量编辑" : "编辑图片"}
                    </button>
                  )}
                  {view === "deleted" && (
                    <button
                      type="button"
                      disabled={!selected.length || interfaceBusy}
                      onClick={() => {
                        void restore([...selected]);
                      }}
                    >
                      <AdminIcon name="arrow-go-back-line" />
                      批量恢复
                    </button>
                  )}
                  {/* 删除结束前会先清空选择，进行中保持两步确认按钮显示「正在删除」。 */}
                  {canTrashReadyItems && (selected.length || batchTrashPending ? (
                    <TwoStepConfirmButton
                      className="danger-button is-subtle"
                      showLabel
                      idleIcon="delete-bin-line"
                      confirmIcon="delete-bin-2-line"
                      busyIcon="delete-bin-5-line"
                      idleLabel="批量删除"
                      confirmLabel="确认删除"
                      busyLabel="正在删除"
                      disabled={batchTrashDisabled}
                      busy={batchTrashPending}
                      invalidationKey={`${view}:${scopeKey}:${pageNumber}:${selected.join(",")}`}
                      onArm={() => {
                        const ids = [...selected];
                        if (!ids.length) return false;
                        frozenBatchTrashIdsRef.current = ids;
                      }}
                      onDisarm={() => {
                        frozenBatchTrashIdsRef.current = [];
                      }}
                      onConfirm={() => {
                        const ids = frozenBatchTrashIdsRef.current;
                        frozenBatchTrashIdsRef.current = [];
                        if (!ids.length) return;
                        setBatchTrashPending(true);
                        void trash(ids).finally(() => {
                          setBatchTrashPending(false);
                        });
                      }}
                    />
                  ) : (
                    <button
                      className="danger-button is-subtle"
                      type="button"
                      disabled={idInputEntryBusy}
                      {...preloadIntentProps(preloadImageIdInput)}
                      onClick={(event) => openImageIdInput("delete", event.currentTarget)}
                    >
                      <AdminIcon name="delete-bin-line" />
                      删除图片
                    </button>
                  ))}
                  {view === "deleted" && canPurgeImage && (
                    <button
                      className="danger-button is-subtle"
                      type="button"
                      disabled={interfaceBusy || (!selected.length && !items.length)}
                      onClick={() => {
                        setConfirmAction(
                          selected.length
                            ? {
                                kind: "purge",
                                request: {
                                  scope: "selected",
                                  ids: [...selected]
                                }
                              }
                            : {
                                kind: "purge",
                                request: { scope: "all" }
                              }
                        );
                      }}
                    >
                      <AdminIcon name="delete-bin-6-line" />
                      <StableButtonLabel
                        idle={selected.length ? "删除已选图" : "清空回收站"}
                        busyText={
                          confirmAction?.kind === "purge"
                            && confirmAction.request.scope === "selected"
                            ? "正在删除"
                            : "正在清空"
                        }
                        busy={actionBusy && (
                          confirmAction?.kind === "purge"
                        )}
                      />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </WorkspaceToolbar>
      </header>
      <div
        key={`grid:${scopeKey}:${pageNumber}`}
        className="admin-scroll-region"
        ref={gridRef}
        data-workspace-content=""
      >
        <div className="admin-image-grid" data-thumbnail-fit={thumbnailFit}>
          {items.map((item) => (
            <AdminImageCard
              key={item.id}
              item={item}
              storageName={storageName}
              checked={selected.includes(item.id)}
              detailDisabled={operationBusy || editorPending}
              detailPending={detailCapability.pendingItemId === item.id}
              onPreloadDetail={detailCapability.preload}
              onCheck={(checked, extendRange) =>
                selection.update(
                  item.id,
                  checked,
                  extendRange,
                  interfaceBusy
                )
              }
              onSelectRange={() => selection.update(
                item.id,
                true,
                true,
                interfaceBusy
              )}
              rangeSelectionHelpId={imageRangeSelectionHelpId}
              onDetail={(opener) => {
                void detailCapability.open(item, opener);
              }}
              editDisabled={editorConflictBusy}
              editPending={
                editorCapability.pending?.itemIds.length === 1 &&
                editorCapability.pending.itemIds[0] === item.id
              }
              onPreloadEdit={() =>
                editorCapability.preload({
                  sources: [item]
                })
              }
              onEdit={(opener) => {
                void editorCapability.open(
                  {
                    sources: [item]
                  },
                  opener
                );
              }}
              canPurge={canPurgeImage}
              onPurge={() => {
                setConfirmAction({
                  kind: "purge",
                  request: { scope: "selected", ids: [item.id] }
                });
              }}
              busy={busyIds.includes(item.id)}
              actionsDisabled={interfaceBusy}
              onTrash={() => {
                void trash([item.id]);
              }}
              onRestore={() => {
                void restore([item.id]);
              }}
            />
          ))}
          {listFailed && (
            <QueryErrorState
              error={listError}
              onRetry={() => void refetchList()}
              reportContext="image_admin.list_load"
            />
          )}
          {isFetching && !items.length && <p className="muted">加载中</p>}
          {!listFailed && !isFetching && !items.length && <p className="muted">暂无记录</p>}
        </div>
      </div>
      <OverlayScrollbar key={`scrollbar:${scopeKey}:${pageNumber}`} targetRef={gridRef} pageEdge />
      <AdminPagination
        ariaLabel="图片列表分页"
        page={pageNumber}
        totalPages={totalPages}
        disabled={interfaceBusy || isFetching}
        nextDisabled={pageNumber >= totalPages}
        onPageChange={loadPage}
      />
      {detailCapability.item && detailCapability.Modal && (
        <detailCapability.Modal
          item={detailCapability.item}
          onClose={detailCapability.close}
          onTrashed={() => showFeedback("图片已移入回收站", "success")}
          returnFocusRef={detailCapability.returnFocusRef}
          storageLabel={storageName(detailCapability.item)}
          admin
        />
      )}
      {editorCapability.session && (
        <editorCapability.session.module.ImageMetadataEditorDialog
          // 弹窗只在挂载时建立会话；新会话一律重新挂载，不沿用上一组图片。
          key={`${editorCapability.session.intent}:${editorCapability.session.items.map((item) => item.id).join(",")}`}
          items={editorCapability.session.items}
          intent={editorCapability.session.intent}
          fromDialog={editorCapability.session.fromDialog}
          pageSize={editPageSize}
          themes={editorCapability.session.vocabulary.themes}
          allTags={editorCapability.session.vocabulary.tags}
          authors={editorCapability.session.vocabulary.authors}
          onClose={editorCapability.close}
          onTrashCommitted={(imageIds) => {
            selection.clear();
            showFeedback(
              imageIds.length === 1
                ? "图片已移入回收站"
                : `${imageIds.length} 张图片已移入回收站`,
              "success"
            );
          }}
          onSaved={refreshAfterEditorSave}
          onStorageMigrationSucceeded={(message) => showFeedback(message, "success")}
          returnFocusRef={editorCapability.returnFocusRef}
        />
      )}
      {idInput && (
        <idInput.Dialog
          intent={idInput.intent}
          onClose={() => setIdInput(null)}
          onResolved={openEditorForImageIds}
          returnFocusRef={idInputOpenerRef}
        />
      )}
      {confirmAction && confirmCopy && (
        <ConfirmDialog
          title={confirmCopy.title}
          description={confirmCopy.description}
          confirmLabel={confirmCopy.label}
          busy={actionBusy}
          confirmDisabled={Boolean(confirmError)}
          requireFinalConfirmation
          finalConfirmationLabel="确认删除"
          finalConfirmationIcon="delete-bin-2-line"
          pendingIcon="delete-bin-5-line"
          pendingLabel="正在删除"
          successLabel="删除完成"
          errorLabel="结果未确认"
          errorMessage={confirmError}
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
      <WorkspaceToolbarScrollbar />
    </section>
  );
}
