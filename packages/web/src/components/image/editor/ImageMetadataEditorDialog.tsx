import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from "react";
import { adminPermissions } from "@imageshow/shared/browser";
import { AdminIcon } from "../../icon/AdminIcon.js";
import { AsyncActionButton } from "../../actions/AsyncActionButton.js";
import { TwoStepConfirmIconButton } from "../../actions/TwoStepConfirmIconButton.js";
import { ConfirmDialog } from "../../feedback/ConfirmDialog.js";
import { DialogFrame } from "../../feedback/DialogFrame.js";
import { WorkflowDefaultFields } from "../../form/WorkflowDefaultFields.js";
import { WorkflowCollapsePanel } from "../../layout/WorkflowCollapsePanel.js";
import { ImageThumbnail } from "../ImageThumbnail.js";
import { ImagePreviewModal } from "../ImagePreviewModal.js";
import { AdminPagination } from "../../navigation/AdminPagination.js";
import { OverlayScrollbar } from "../../layout/OverlayScrollbar.js";
import { ImageDraftFields } from "../../form/ImageDraftFields.js";
import { useAsyncActionStatus } from "../../../hooks/useAsyncActionStatus.js";
import { moveImageToTrash } from "../../../lib/api/image-mutations.js";
import { useAdminPermissions } from "../../../hooks/useAuthSession.js";
import {
  createPageLifetimeModuleLoader
} from "../../../lib/page-lifetime-module-loader.js";
import { facetDisplayName, formatBytes, formatDimensions, shortImageId } from "../../../lib/ui/formatters.js";
import { preloadIntentProps } from "../../../lib/ui/preload-intent.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import { batchCommonBrightnessOptions, batchCommonDeviceOptions, cardBrightnessSelectOptions, editCardDeviceSelectOptions } from "../../../lib/ui/select-options.js";
import { storageNameResolver, useStorageOptions } from "../../../lib/api/storage-options.js";
import type {
  BatchEditableImageSnapshot,
  Brightness,
  Device,
  FacetOption,
  ImageDraft
} from "../../../lib/types.js";
import { mergeBatchEditCommonAttributes } from "../../../lib/upload/upload-utils.js";
import {
  useBatchMetadataOperations
} from "./useBatchMetadataOperations.js";
import {
  batchMetadataCardSaveState,
  changedMetadataUpdate,
  createBatchMetadataSession,
  fieldsChangedFor,
  reconcileBatchMetadataSession,
  restoreBatchMetadataDrafts
} from "./batch-metadata-session.js";

type BatchStorageMigrationDialogModule =
  typeof import("./BatchStorageMigrationDialog.js");

const loadBatchStorageMigrationDialog =
  createPageLifetimeModuleLoader<BatchStorageMigrationDialogModule>(
    () => import("./BatchStorageMigrationDialog.js")
  );
const preloadBatchStorageMigrationDialog = () => {
  void loadBatchStorageMigrationDialog().catch(() => undefined);
};
const BatchStorageMigrationDialog = lazy(() => loadBatchStorageMigrationDialog().then((module) => ({
  default: module.BatchStorageMigrationDialog
})));

function emptyCommonAttributes() {
  return {
    device: "" as "" | "auto" | Device,
    brightness: "" as "" | "auto" | Brightness,
    theme: "",
    author: "",
    tags: [] as string[]
  };
}

export type ImageMetadataEditorMode =
  | {
      kind: "single";
      item: BatchEditableImageSnapshot;
      onDeleted: (imageId: string) => void | Promise<void>;
    }
  | {
      kind: "batch";
      items: BatchEditableImageSnapshot[];
      pageSize: number;
    };

export function ImageMetadataEditorDialog({
  mode,
  themes,
  allTags,
  authors,
  onClose,
  onSaved,
  onStorageMigrationSucceeded,
  returnFocusRef
}: {
  mode: ImageMetadataEditorMode;
  themes: FacetOption[];
  allTags: FacetOption[];
  authors: FacetOption[];
  onClose: () => void;
  onSaved: (
    authoritativeItems?: BatchEditableImageSnapshot[] | null
  ) => void | Promise<void>;
  onStorageMigrationSucceeded?: (message: string) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const singleMode = mode.kind === "single";
  const batchMode = mode.kind === "batch";
  const items = singleMode ? [mode.item] : mode.items;
  const pageSize = singleMode ? 1 : mode.pageSize;
  const title = singleMode ? "编辑图片" : "批量编辑图片";
  const listRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const migrateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);
  // 父级刷新可能清空选择或因筛选移除图片；弹窗独立持有固定会话 ID、活动成员、
  // PostgreSQL 权威基线和草稿，保存留窗期间不再从父列表重建状态。
  const [sessionItemIds] = useState(() => items.map((item) => item.id));
  const [session, setSession] = useState(() => createBatchMetadataSession(items));
  const operations = useBatchMetadataOperations({
    initialIds: sessionItemIds,
    onSaved
  });
  const {
    pendingReconciliation,
    reconcilePendingSave,
    save,
    saveStatus,
    lastSaveReport
  } = operations;
  const saving = saveStatus.pending;
  const deleteStatus = useAsyncActionStatus({ successDurationMs: null });
  const [deleteError, setDeleteError] = useState("");
  const busy = saving || deleteStatus.pending;
  const [preview, setPreview] = useState<{ src: string; thumbSrc: string; width: number; height: number } | null>(null);
  const [page, setPage] = useState(1);

  const [common, setCommon] = useState(emptyCommonAttributes);
  const [commonExpanded, setCommonExpanded] = useState(false);
  const [restoreConfirmation, setRestoreConfirmation] = useState(false);
  const [restoreError, setRestoreError] = useState("");
  const [migrating, setMigrating] = useState(false);
  const permissions = useAdminPermissions();
  const canMigrateStorage = permissions.includes(
    adminPermissions.imageStorageMigrate
  );
  const { data: storageOptionsData } = useStorageOptions();
  // 列表行左下角的「所在存储」展示后端显示名。
  const resolveStorageName = storageNameResolver(storageOptionsData?.backends ?? []);
  const activeIdSet = new Set(session.activeIds);
  const activeItems = session.baselineItems.filter((item) => activeIdSet.has(item.id));
  const deleteAvailable = singleMode && activeItems.length === 1;
  const totalPages = Math.max(1, Math.ceil(activeItems.length / pageSize));
  const paginationAvailable = batchMode && totalPages > 1;
  const visibleItems = activeItems.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => setPage((current) => Math.min(current, totalPages)), [totalPages]);
  const patchDraft = (id: string, patch: Partial<ImageDraft>) => setSession((current) => ({
    ...current,
    drafts: {
      ...current.drafts,
      [id]: { ...current.drafts[id], ...patch }
    }
  }));
  const remove = (id: string) => setSession((current) => ({
    ...current,
    activeIds: current.activeIds.filter((candidate) => candidate !== id)
  }));

  const changedByItem = new Map(activeItems.map((item) => [
    item.id,
    fieldsChangedFor(item, session.drafts[item.id])
  ]));
  const changedCount = activeItems.filter((item) => Object.values(changedByItem.get(item.id)!).some(Boolean)).length;
  const savePresentation = {
    idle: pendingReconciliation
      ? { icon: "refresh-line" as const, label: "确认保存结果" }
      : changedCount
        ? { label: `保存${changedCount}项` }
        : { icon: "save-3-line" as const, label: "保存" },
    pending: pendingReconciliation
      ? { icon: "refresh-line" as const, label: "确认中" }
      : { icon: "save-3-line" as const, label: "保存中" },
    success: { icon: "check-line", label: "保存成功" },
    error: { icon: "close-line", label: "保存失败" }
  } as const;
  const modalSubtitle = singleMode
    ? (activeItems[0]?.object_key ?? "")
    : `${activeItems.length} 张图片`;

  const commonChanged = { device: common.device !== "", brightness: common.brightness !== "", theme: common.theme.trim() !== "", author: common.author.trim() !== "", tags: common.tags.length > 0 };
  const commonHasValue = commonChanged.device || commonChanged.brightness || commonChanged.theme || commonChanged.author || commonChanged.tags;
  const restoreAvailable = changedCount > 0;
  const commonSummary = [
    batchCommonDeviceOptions.find((option) => option.value === common.device)?.label ?? "设备不变",
    batchCommonBrightnessOptions.find((option) => option.value === common.brightness)?.label ?? "亮暗不变",
    facetDisplayName(themes, common.theme, "主题不变"),
    facetDisplayName(authors, common.author, "作者不变"),
    `${common.tags.length} 个标签`,
  ].join(" · ");
  const saveAll = async () => {
    const changedItems = activeItems.flatMap((item) => {
      const changed = changedByItem.get(item.id)!;
      if (!Object.values(changed).some(Boolean)) return [];
      return [changedMetadataUpdate(item, session.drafts[item.id], changed)];
    });
    if (!changedItems.length && !pendingReconciliation) return false;
    const outcome = await save(changedItems, session.activeIds);
    const authoritativeItems = outcome?.authoritativeItems;
    if (authoritativeItems) {
      setSession((current) => reconcileBatchMetadataSession(
        current,
        outcome.attempt,
        authoritativeItems
      ));
    }
    return Boolean(
      outcome
      && (
        outcome.report.snapshotFailed
        || (
          outcome.report.failed === 0
          && outcome.report.unavailableIds.length === 0
        )
      )
    );
  };
  const restoreAllChanges = async () => {
    setRestoreError("");
    if (pendingReconciliation) {
      const outcome = await reconcilePendingSave();
      const authoritativeItems = outcome?.authoritativeItems;
      if (!authoritativeItems) {
        setRestoreError("权威数据读取失败，未保存草稿已保留，请稍后重试。");
        return false;
      }
      setSession((current) => restoreBatchMetadataDrafts(
        reconcileBatchMetadataSession(
          current,
          outcome.attempt,
          authoritativeItems
        )
      ));
      return true;
    }
    setSession((current) => restoreBatchMetadataDrafts(current));
    return true;
  };
  const deleteSingleImage = async (requestClose: () => void) => {
    const item = activeItems[0];
    if (!deleteAvailable || !item || mode.kind !== "single" || busy) return;

    const deleted = await deleteStatus.run(async () => {
      setDeleteError("");
      try {
        await moveImageToTrash(item.id);
      } catch (error) {
        reportAdminUiError("image_metadata.single_delete", error);
        setDeleteError("删除失败，请稍后重试");
        return false;
      }

      // 删除已经由服务端提交后，刷新失败不能诱导用户再次执行 mutation。
      // 各入口在这里补齐自己的列表并关闭详情，异常只单独记录。
      try {
        await mode.onDeleted(item.id);
      } catch (refreshError) {
        reportAdminUiError(
          "image_metadata.single_delete_refresh",
          refreshError,
          { imageId: item.id }
        );
      }
      return true;
    });
    if (deleted) requestClose();
  };
  return (
    <DialogFrame
      className="modal edit-modal batch-edit-overlay"
      ariaLabel={title}
      busy={busy}
      paused={Boolean(
        (canMigrateStorage && migrating)
        || preview
        || restoreConfirmation
      )}
      initialFocusRef={closeButtonRef}
      returnFocusRef={returnFocusRef}
      onClose={onClose}
    >
      {({ requestClose }) => (
      <>
      <form
        className={`batch-edit-modal image-workflow-window${singleMode ? " is-single" : ""}`}
        tabIndex={-1}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          await saveAll();
        }}
      >
        <header>
          <div>
            <h2>{title}</h2>
            <p title={singleMode ? modalSubtitle : undefined}>{modalSubtitle}</p>
          </div>
          <div className="batch-edit-header-actions">
            <button
              ref={restoreTriggerRef}
              className="batch-edit-restore-button"
              type="button"
              title="撤销所有未保存修改"
              disabled={busy || !restoreAvailable}
              onClick={() => {
                setRestoreError("");
                setRestoreConfirmation(true);
              }}
            >
              <AdminIcon name="history-line" />复原
            </button>
            <button
              ref={closeButtonRef}
              className="icon close pressable"
              type="button"
              title="关闭"
              disabled={busy}
              onClick={() => requestClose()}
            >
              <AdminIcon name="close-line" />
            </button>
          </div>
        </header>
        {batchMode && (
          <WorkflowCollapsePanel
            className="batch-edit-common-panel"
            contentClassName="batch-edit-common workflow-defaults"
            title="批量默认属性"
            summary={commonSummary}
            expanded={commonExpanded}
            onExpandedChange={setCommonExpanded}
          >
            <WorkflowDefaultFields
              values={common}
              onChange={{
                device: (device) => setCommon({
                  ...common,
                  device: device as "" | "auto" | Device
                }),
                brightness: (brightness) => setCommon({
                  ...common,
                  brightness: brightness as "" | "auto" | Brightness
                }),
                theme: (theme) => setCommon({ ...common, theme }),
                author: (author) => setCommon({ ...common, author }),
                tags: (tags) => setCommon({ ...common, tags })
              }}
              deviceOptions={batchCommonDeviceOptions}
              brightnessOptions={batchCommonBrightnessOptions}
              themes={themes}
              authors={authors}
              tags={allTags}
              placeholders={{
                theme: "主题不变",
                author: "作者不变",
                tags: "追加标签"
              }}
              ariaLabels={{
                device: "批量设备",
                brightness: "批量亮度",
                theme: "批量主题",
                author: "批量作者",
                tags: "批量标签"
              }}
              changed={commonChanged}
              applyDisabled={busy}
              applyReady={commonHasValue}
              onApply={() => setSession((current) => ({
                ...current,
                drafts: Object.fromEntries(
                  Object.entries(current.drafts).map(([id, draft]) => {
                    if (!current.activeIds.includes(id)) return [id, draft];
                    return [id, mergeBatchEditCommonAttributes(draft, common)];
                  })
                )
              }))}
            />
          </WorkflowCollapsePanel>
        )}
        <div
          className="modal-scroll-list image-workflow-list batch-edit-list"
          ref={listRef}
        >
          {deleteError && (
            <p className="batch-edit-delete-error" role="alert">
              {deleteError}
            </p>
          )}
          {visibleItems.map((item) => {
            const draft = session.drafts[item.id];
            const changed = changedByItem.get(item.id)!;
            const cardChanged = Object.values(changed).some(Boolean);
            const lastSaveState = batchMetadataCardSaveState(
              lastSaveReport,
              item.id
            );
            // A new edit supersedes an earlier success badge. Failed and
            // pending cards keep their feedback because their draft still
            // needs another save or an authoritative confirmation.
            const cardSaveState = cardChanged && lastSaveState === "saved"
              ? null
              : lastSaveState;
            const saveStatePresentation = cardSaveState
              ? {
                  saved: {
                    rowClassName: "is-save-saved",
                    badgeClassName: "is-saved",
                    label: "保存成功"
                  },
                  failed: {
                    rowClassName: "is-save-failed",
                    badgeClassName: "is-failed",
                    label: "保存失败"
                  },
                  pending: {
                    rowClassName: "is-save-pending",
                    badgeClassName: "is-pending",
                    label: "待确认"
                  }
                }[cardSaveState]
              : null;
            return (
              <article
                key={item.id}
                className={`batch-edit-row${cardChanged ? " is-changed" : ""}${saveStatePresentation ? ` ${saveStatePresentation.rowClassName}` : ""}`}
              >
                <div className="batch-edit-preview">
                  <ImageThumbnail
                    src={item.thumb_url}
                    fallbackSrc={item.thumb_fallback_url}
                    onClick={(opener) => {
                      previewReturnFocusRef.current = opener;
                      setPreview({
                        src: item.object_url,
                        thumbSrc: item.thumb_url,
                        width: item.width,
                        height: item.height
                      });
                    }}
                  />
                  {item.image_size
                    ? <span className="batch-edit-preview-size">{formatBytes(item.image_size)}</span>
                    : null}
                </div>
                <div className="batch-edit-content">
                  <div className="batch-edit-head">
                    <div>
                      <div className="batch-edit-head-name">
                        <strong className="batch-edit-title-desktop" title={item.object_key}>{item.id}</strong>
                        <strong className="batch-edit-title-mobile" title={item.id}>{shortImageId(item.id)}</strong>
                        {saveStatePresentation ? (
                          <span className={`batch-edit-save-badge ${saveStatePresentation.badgeClassName}`}>
                            {saveStatePresentation.label}
                          </span>
                        ) : cardChanged ? (
                          <span className="changed-badge">已修改</span>
                        ) : null}
                      </div>
                      <span className="batch-edit-desktop-summary">
                        {formatDimensions(item.width, item.height)} · {item.theme} · {item.device}/{item.brightness} · {resolveStorageName(item)}
                      </span>
                      <span className="batch-edit-summary-line batch-edit-mobile-summary">
                        {formatDimensions(item.width, item.height)} · {item.device}/{item.brightness} · {item.theme}
                      </span>
                      <span className="batch-edit-summary-line batch-edit-mobile-summary">
                        {item.image_size ? formatBytes(item.image_size) : "大小未记录"} · {resolveStorageName(item)}
                      </span>
                    </div>
                    {batchMode && (
                      <button
                        className="icon danger-button"
                        type="button"
                        title="从批量编辑中移除"
                        disabled={busy}
                        onClick={() => remove(item.id)}
                      >
                        <AdminIcon name="close-line" />
                      </button>
                    )}
                  </div>
                </div>
                <ImageDraftFields
                  draft={draft}
                  onPatch={(patch) => patchDraft(item.id, patch)}
                  themes={themes}
                  allTags={allTags}
                  authors={authors}
                  deviceOptions={editCardDeviceSelectOptions}
                  brightnessOptions={cardBrightnessSelectOptions}
                  disabled={busy}
                  ariaPrefix={item.id}
                  changed={changed}
                />
              </article>
            );
          })}
          {!activeItems.length && <p className="batch-edit-empty-state">批量编辑列表为空</p>}
        </div>
        <footer className={`image-workflow-footer${paginationAvailable ? " has-pagination" : ""}`}>
          {(canMigrateStorage || deleteAvailable) && (
            <div className="batch-edit-resource-actions image-workflow-leading-actions">
              {canMigrateStorage && (
                <button
                  ref={migrateTriggerRef}
                  className="batch-edit-migrate-trigger"
                  type="button"
                  disabled={busy || !activeItems.length}
                  {...preloadIntentProps(preloadBatchStorageMigrationDialog)}
                  onClick={() => setMigrating(true)}
                >
                  <AdminIcon name="arrow-left-right-line" />{batchMode ? "批量迁移存储" : "迁移存储"}
                </button>
              )}
              {deleteAvailable && (
                <TwoStepConfirmIconButton
                  className="icon danger-button batch-edit-delete-trigger"
                  idleIcon="delete-bin-6-line"
                  confirmIcon="delete-bin-2-line"
                  idleLabel="删除此图片"
                  confirmLabel="再次点击确认删除此图片"
                  busy={deleteStatus.pending}
                  disabled={busy || !activeItems.length}
                  onArm={() => setDeleteError("")}
                  onConfirm={() => void deleteSingleImage(requestClose)}
                />
              )}
            </div>
          )}
          {paginationAvailable && (
            <AdminPagination
              className="image-workflow-pagination"
              ariaLabel="批量编辑分页"
              page={page}
              totalPages={totalPages}
              disabled={busy}
              onPageChange={setPage}
            />
          )}
          <div className="modal-footer-actions">
            <button type="button" disabled={busy} onClick={() => requestClose()}>取消</button>
            <AsyncActionButton
              className={`button workflow-submit-button${batchMode ? " batch-edit-save-button" : ""}`}
              type="submit"
              status={saveStatus.status}
              presentation={savePresentation}
              disabled={busy || (!changedCount && !pendingReconciliation)}
            />
          </div>
        </footer>
      </form>
      <OverlayScrollbar targetRef={listRef} />
      {canMigrateStorage && migrating && (
        <Suspense fallback={null}>
          <BatchStorageMigrationDialog
            open
            imageIds={activeItems.map((item) => item.id)}
            currentStorageSlugs={activeItems.map((item) => item.storage_slug)}
            single={singleMode}
            returnFocusRef={migrateTriggerRef}
            onClose={() => setMigrating(false)}
            onSaved={onSaved}
            onSucceeded={(message) => {
              setMigrating(false);
              onStorageMigrationSucceeded?.(message);
              requestClose();
            }}
          />
        </Suspense>
      )}
      {preview && <ImagePreviewModal src={preview.src} thumbSrc={preview.thumbSrc} width={preview.width} height={preview.height} onClose={() => setPreview(null)} returnFocusRef={previewReturnFocusRef} />}
      {restoreConfirmation && (
        <ConfirmDialog
          title="确认复原全部修改"
          description="将当前活动图片尚未保存的属性草稿恢复到最近一次权威基线；图片列表成员、分页、批量默认属性、卡片保存状态及已经保存的修改都不会改变。"
          confirmLabel="确认复原"
          pendingLabel="复原中"
          successLabel="已复原"
          danger={false}
          confirmIcon="history-line"
          closeOnBackdrop
          errorMessage={restoreError}
          returnFocusRef={restoreTriggerRef}
          onClose={() => setRestoreConfirmation(false)}
          onConfirm={restoreAllChanges}
        />
      )}
      </>
      )}
    </DialogFrame>
  );
}
