import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  adminPermissions,
  type AdminImageSort,
  type AdminSettings,
  type AdminImageListItemDto
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
import { ImageListViewControls } from "../../../components/image/ImageListViewControls.js";
import { AdminImageCard } from "./AdminImageCard.js";
import {
  emptyImageAdminFilters,
  ImageAdminFilters,
  type ImageAdminFilterValues
} from "./ImageAdminFilters.js";
import { IngestionLauncher } from "../ingestion/IngestionLauncher.js";
import {
  invalidateImageData,
  invalidateImageDataAfterAdminListMutation,
  invalidateImageDataAfterMetadataSave
} from "../../../lib/api/query-invalidation.js";
import { useAdminPermissions } from "../../../hooks/useAuthSession.js";
import { useAdminPreference } from "../../../hooks/useAdminPreferences.js";
import { useAdminImageDetailCapability } from "../../../components/image/useAdminImageDetailCapability.js";
import { useImageEditorCapability } from "../../../components/image/editor/useImageEditorCapability.js";
import type {
  ImageEditorIntent,
  ImageMetadataSaveCommit
} from "../../../components/image/editor/image-editor-capability-loader.js";
import {
  mobileViewportMediaQuery,
  useMediaQuery
} from "../../../hooks/useMediaQuery.js";
import { useWorkspaceToolbarCollapse } from "../../../hooks/useWorkspaceToolbarCollapse.js";
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
import { preloadImageIdInput, useImageIdInputEntry } from "./useImageIdInputEntry.js";
import {
  ImageGridStatus,
  ImageListSelectionBar,
  ImageListViewSwitch,
  imageRangeSelectionHelpId,
  useImageListPageReset
} from "./ImageListPageParts.js";
import { imageAdminPaginationScopeKey } from "./image-admin-list-query.js";
import "../../../styles/admin/images.css";

const viewOptions = [
  { value: "ready", label: "图库" },
  { value: "deleted", label: "回收站" }
] as const;

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
    isFetching,
    scopeKey,
    pageNumber,
    totalPages
  } = navigation;
  const selection = useImageAdminSelection(items);
  const { selected, selectedItems } = selection;
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
  const idInput = useImageIdInputEntry<ImageEditorIntent>({
    onLoadError: (error) => {
      reportAdminUiError("image_admin.id_input_load", error);
      showFeedback("按 ID 指定图片功能加载失败，请重新加载页面", "error");
    }
  });
  const editorConflictBusy = operationBusy || detailPending;
  const modalOpen = Boolean(
    detailCapability.item
    || editorCapability.session
    || confirmAction
    || idInput.session
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
  useImageListPageReset(clearImageSelection, gridRef, scopeKey, pageNumber);
  const preloadBatchEditor = () =>
    editorCapability.preload({
      sources: selectedItems
    });
  const selectedEditorPending = Boolean(
    editorCapability.pending &&
    editorCapability.pending.itemIds.length === selectedItems.length &&
    selectedItems.every((item, index) => editorCapability.pending?.itemIds[index] === item.id)
  );
  const confirmCopy = imageAdminConfirmationCopy(confirmAction);
  const pageStatusSuffix = isFetching
    ? " · 加载中"
    : hasCurrentPageData
      ? ` · 本页 ${items.length} 项`
      : "";
  // 窄屏切换放在标题行，桌面留在工具区；两处共用同一组按钮。
  const viewSwitch = (
    <ImageListViewSwitch
      options={viewOptions}
      value={view}
      disabled={interfaceBusy}
      onChange={changeView}
    />
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
              `共 ${total} 项${pageStatusSuffix}`}
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
              <ImageListSelectionBar selection={selection} disabled={interfaceBusy} />
              <div className="image-list-toolbar-actions">
                <ImageListViewControls
                  sort={sort}
                  thumbnailFit={thumbnailFit}
                  disabled={interfaceBusy}
                  onSortChange={changeSort}
                  onThumbnailFitChange={setThumbnailFit}
                />
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
                          void idInput.open("edit", event.currentTarget);
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
                      onClick={(event) => void idInput.open("delete", event.currentTarget)}
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
          <ImageGridStatus
            navigation={navigation}
            reportContext="image_admin.list_load"
            emptyText="暂无记录"
          />
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
      {idInput.session && (
        <idInput.session.Dialog
          intent={idInput.session.intent}
          onClose={idInput.close}
          onResolved={(items) => idInput.handOff(editorCapability.open, items)}
          returnFocusRef={idInput.returnFocusRef}
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
