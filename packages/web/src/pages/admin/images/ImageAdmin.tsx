import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { adminPermissions } from "@imageshow/shared/browser";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { StableButtonLabel } from "../../../components/data-display/StableButtonLabel.js";
import { ConfirmDialog } from "../../../components/feedback/ConfirmDialog.js";
import {
  ActionFeedbackOutlet,
  ActionFeedbackRegion,
  useActionFeedbackTarget
} from "../../../components/feedback/ActionFeedbackRegion.js";
import { LabeledSwitch } from "../../../components/form/LabeledSwitch.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import { AdminPagination } from "../../../components/navigation/AdminPagination.js";
import { adminImagePageLimit } from "../../../lib/constants.js";
import { preloadIntentProps } from "../../../lib/ui/preload-intent.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import { useAdminSettings } from "../../../lib/api/admin-settings.js";
import { useIngestionVocabulary } from "../../../lib/api/ingestion-vocabulary.js";
import { useStorageNameResolver } from "../../../lib/api/storage-options.js";
import type { AdminImageListItem } from "../../../lib/types.js";
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
  invalidateImageDataAfterMetadataSave
} from "../../../lib/api/query-invalidation.js";
import { useAdminPreference } from "../../../hooks/useAdminPreferences.js";
import { useAdminPermissions } from "../../../hooks/useAuthSession.js";
import { useAdminImageDetailCapability } from "../../../components/image/useAdminImageDetailCapability.js";
import { useImageEditorCapability } from "../../../components/image/editor/useImageEditorCapability.js";
import type {
  ImageMetadataSaveCommit
} from "../../../components/image/editor/image-editor-capability-loader.js";
import {
  mobileViewportMediaQuery,
  useMediaQuery
} from "../../../hooks/useMediaQuery.js";
import {
  imageAdminConfirmationCopy,
  useImageAdminOperations,
  type ImageAdminView
} from "./useImageAdminOperations.js";
import { useImageAdminSelection } from "./useImageAdminSelection.js";
import { useImageAdminPageNavigation } from "./useImageAdminPageNavigation.js";
import "../../../styles/admin/images.css";

const imageRangeSelectionHelpId = "admin-image-range-selection-help";

export function ImageAdmin() {
  const [searchParams, setSearchParams] = useSearchParams();
  const viewParam = searchParams.get("view");
  const routeView: ImageAdminView = viewParam === "unset" || viewParam === "deleted"
    ? viewParam
    : "ready";
  const [view, setView] = useState<ImageAdminView>(routeView);
  const [filters, setFilters] = useState<ImageAdminFilterValues>(
    emptyImageAdminFilters
  );
  const [cardDensity, setCardDensity] = useAdminPreference("image_card_density");
  const [ingestionPending, setIngestionPending] = useState(false);
  const mobileLayout = useMediaQuery(mobileViewportMediaQuery);
  const permissions = useAdminPermissions();
  const canPurgeImage = permissions.includes(
    adminPermissions.imageTrashPurge
  );

  const feedbackTarget = useActionFeedbackTarget("image-admin");
  const gridRef = useRef<HTMLDivElement | null>(null);
  const client = useQueryClient();
  const { data: settingsData } = useAdminSettings();

  const { data: vocabulary } = useIngestionVocabulary();
  // 列表卡片的「所在存储」展示后端显示名（而非 slug）；从后端列表解析。
  const storageName = useStorageNameResolver();
  const pageSize = settingsData?.settings.admin.image_page_size ?? adminImagePageLimit;
  const editPageSize = settingsData?.settings.upload.list_page_size ?? 20;
  const navigation = useImageAdminPageNavigation({
    view,
    filters,
    pageSize,
    enabled: Boolean(settingsData)
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
    totalPages,
  } = navigation;
  const selection = useImageAdminSelection(items);
  const {
    selected,
    selectedItems,
    allSelected
  } = selection;
  const invalidateData = useCallback(async () => {
    await invalidateImageData(client);
  }, [client]);
  const refreshAfterEditorSave = useCallback(async (
    commit?: ImageMetadataSaveCommit
  ) => {
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
  }, [client, selection.clear]);
  const {
    operationText,
    feedback,
    setFeedback,
    showFeedback,
    confirmAction,
    setConfirmAction,
    actionBusy,
    busyIds,
    operationBusy,
    resetTransientState,
    runConfirmedAction,
    trash,
    purge,
    restore
  } = useImageAdminOperations({
    items,
    clearSelection: selection.clear,
    invalidateData
  });
  const detailCapability = useAdminImageDetailCapability<AdminImageListItem>((error) => {
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
  const editorConflictBusy = operationBusy || detailPending || ingestionPending;
  const modalOpen = Boolean(
    detailCapability.item || editorCapability.session || confirmAction
  );
  const interfaceBusy = editorConflictBusy || editorPending || modalOpen;
  const clearImageSelection = selection.clear;
  const finishIngestionBatch = selection.clear;
  const canTrashReadyItems = view !== "deleted";
  useEffect(() => {
    if (routeView === view) return;
    setView(routeView);
    clearImageSelection();
    resetTransientState();
    gridRef.current?.scrollTo({ top: 0, left: 0 });
  }, [
    clearImageSelection,
    resetTransientState,
    routeView,
    view
  ]);
  const changeFilter = (
    key: keyof ImageAdminFilterValues,
    nextValue: string
  ) => {
    if (filters[key] === nextValue || interfaceBusy) return;
    setFilters((current) => ({ ...current, [key]: nextValue }));
    clearImageSelection();
    resetTransientState();
    gridRef.current?.scrollTo({ top: 0, left: 0 });
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
    gridRef.current?.scrollTo({ top: 0, left: 0 });
  }, [clearImageSelection, pageNumber, scopeKey]);
  const preloadBatchEditor = () => editorCapability.preload({
    sources: selectedItems
  });
  const selectedEditorPending = Boolean(
    editorCapability.pending
    && editorCapability.pending.itemIds.length === selectedItems.length
    && selectedItems.every(
      (item, index) => editorCapability.pending?.itemIds[index] === item.id
    )
  );
  const confirmCopy = imageAdminConfirmationCopy(confirmAction);
  const pageStatusSuffix = isFetching
    ? " · 加载中"
    : hasCurrentPageData
      ? ` · 本页 ${items.length} 项`
      : "";
  return (
    <section
      className="workspace workspace-paged"
      onClick={(event) => selection.clearFromPageClick(event, interfaceBusy)}
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
              `第 ${pageNumber} / ${totalPages} 页 · 共 ${total} 项${pageStatusSuffix}`
            )}
          </p>
        </div>
        <div className="image-admin-head-tools">
          <IngestionLauncher
            showTriggers={view === "ready"}
            disabled={operationBusy || detailPending || editorPending}
            onDone={finishIngestionBatch}
            onLoadError={(error) => {
              reportAdminUiError("image_admin.ingestion_load", error);
              showFeedback("上传与导入功能加载失败，请重新加载页面", "error");
            }}
            onPendingChange={(pending) => {
              setIngestionPending(pending);
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
                    || selectedEditorPending
                  }
                  aria-busy={selectedEditorPending || undefined}
                   {...preloadIntentProps(preloadBatchEditor)}
                   onClick={(event) => {
                     void editorCapability.open({
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
                    void restore([...selected]);
                  }}
                >
                  <AdminIcon name="arrow-go-back-line" />批量恢复
                </button>
              )}
              {canTrashReadyItems && (
                <button
                  className="danger-button"
                  type="button"
                  disabled={!selected.length || interfaceBusy}
                  onClick={() => {
                    setConfirmAction({ kind: "trash", ids: [...selected] });
                  }}
                >
                  <AdminIcon name="delete-bin-6-line" />批量删除
                </button>
              )}
              {view === "deleted" && canPurgeImage && (
                <button
                  className="danger-button"
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
                  <AdminIcon name="delete-bin-7-line" />
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
      <div
        key={`grid:${scopeKey}:${pageNumber}`}
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
              detailDisabled={operationBusy || ingestionPending || editorPending}
              detailPending={detailCapability.pendingItemId === item.id}
              onPreloadDetail={detailCapability.preload}
              onCheck={(checked, extendRange) => selection.update(
                item.id,
                checked,
                extendRange,
                interfaceBusy
              )}
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
                editorCapability.pending?.itemIds.length === 1
                && editorCapability.pending.itemIds[0] === item.id
              }
              onPreloadEdit={() => editorCapability.preload({
                sources: [item]
              })}
              onEdit={(opener) => {
                void editorCapability.open({
                  sources: [item]
                }, opener);
              }}
              canPurge={canPurgeImage}
              onPurge={() => {
                void purge({ scope: "selected", ids: [item.id] });
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
          {listFailed && <QueryErrorState error={listError} onRetry={() => void refetchList()} reportContext="image_admin.list_load" />}
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
          items={editorCapability.session.items}
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
