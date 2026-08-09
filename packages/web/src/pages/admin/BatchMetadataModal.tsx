import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from "react";
import { adminPermissions } from "@imageshow/shared/browser";
import { AdminIcon } from "../../components/icon/AdminIcon.js";
import { AsyncActionButton } from "../../components/actions/AsyncActionButton.js";
import { TwoStepConfirmIconButton } from "../../components/actions/TwoStepConfirmIconButton.js";
import { ConfirmDialog } from "../../components/feedback/ConfirmDialog.js";
import { DialogFrame } from "../../components/feedback/DialogFrame.js";
import { WorkflowDefaultFields } from "../../components/form/WorkflowDefaultFields.js";
import { WorkflowCollapsePanel } from "../../components/layout/WorkflowCollapsePanel.js";
import { ImageThumbnail } from "../../components/image/ImageThumbnail.js";
import { ImagePreviewModal } from "../../components/image/ImagePreviewModal.js";
import { AdminPagination } from "../../components/navigation/AdminPagination.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { ImageDraftFields } from "../../components/form/ImageDraftFields.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";
import { moveImageToTrash } from "../../lib/api/image-mutations.js";
import { useAdminPermissions } from "../../lib/api/site-data.js";
import {
  createPageLifetimeModuleLoader
} from "../../lib/page-lifetime-module-loader.js";
import { facetDisplayName, formatBytes, formatDimensions, shortImageId } from "../../lib/ui/formatters.js";
import { preloadIntentProps } from "../../lib/ui/preload-intent.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { batchCommonBrightnessOptions, batchCommonDeviceOptions, cardBrightnessSelectOptions, editCardDeviceSelectOptions } from "../../lib/ui/select-options.js";
import { storageNameResolver, useStorageOptions } from "../../lib/api/storage-options.js";
import type {
  BatchEditableImageSnapshot,
  Brightness,
  Device,
  FacetOption,
  ImageDraft
} from "../../lib/types.js";
import { mergeBatchEditCommonAttributes, normalizeAuthor, normalizeTheme } from "../../lib/upload/upload-utils.js";
import { BatchMetadataSaveSummary } from "./BatchMetadataSaveSummary.js";
import {
  useBatchMetadataOperations,
  type BatchMetadataUpdate
} from "./useBatchMetadataOperations.js";

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

type BatchMetadataChanges = Record<keyof ImageDraft, boolean>;

function draftFromImage(item: BatchEditableImageSnapshot): ImageDraft {
  return {
    title: item.title,
    description: item.description,
    source: item.source,
    original: item.original,
    device: item.device,
    brightness: item.brightness,
    theme: item.theme === "none" ? "" : item.theme,
    author: item.author === "none" ? "" : item.author,
    tags: item.tags
  };
}

function draftsFromImages(items: BatchEditableImageSnapshot[]) {
  return Object.fromEntries(items.map((item) => [item.id, draftFromImage(item)]));
}

function emptyCommonAttributes() {
  return {
    device: "" as "" | "auto" | Device,
    brightness: "" as "" | "auto" | Brightness,
    theme: "",
    author: "",
    tags: [] as string[]
  };
}

function tagsChanged(draftTags: string[], savedTags: string[]) {
  return JSON.stringify([...draftTags].sort()) !== JSON.stringify([...savedTags].sort());
}

function fieldsChangedFor(
  item: BatchEditableImageSnapshot,
  draft: ImageDraft
): BatchMetadataChanges {
  return {
    title: draft.title !== item.title,
    description: draft.description !== item.description,
    source: draft.source !== item.source,
    original: draft.original !== item.original,
    device: draft.device !== item.device,
    brightness: draft.brightness !== item.brightness,
    theme: normalizeTheme(draft.theme) !== normalizeTheme(item.theme),
    author: normalizeAuthor(draft.author) !== normalizeAuthor(item.author === "none" ? "" : item.author),
    tags: tagsChanged(draft.tags, item.tags ?? [])
  };
}

function changedMetadataUpdate(
  item: BatchEditableImageSnapshot,
  draft: ImageDraft,
  changed: BatchMetadataChanges
): BatchMetadataUpdate {
  const update: BatchMetadataUpdate = { id: item.id };
  if (changed.title) update.title = draft.title;
  if (changed.description) update.description = draft.description;
  if (changed.source) update.source = draft.source;
  if (changed.original) update.original = draft.original;
  if (changed.device) update.device = draft.device;
  if (changed.brightness) update.brightness = draft.brightness;
  if (changed.theme) update.theme = normalizeTheme(draft.theme);
  if (changed.author) update.author = normalizeAuthor(draft.author);
  if (changed.tags) update.tags = draft.tags;
  return update;
}

export function BatchMetadataModal({
  items,
  pageSize,
  themes,
  allTags,
  authors,
  onClose,
  onSaved,
  onDeleted,
  onStorageMigrationSucceeded,
  returnFocusRef,
  single = false
}: {
  items: BatchEditableImageSnapshot[];
  pageSize: number;
  themes: FacetOption[];
  allTags: FacetOption[];
  authors: FacetOption[];
  onClose: () => void;
  onSaved: (
    authoritativeItems?: BatchEditableImageSnapshot[] | null
  ) => void | Promise<void>;
  onDeleted?: (imageId: string) => void | Promise<void>;
  onStorageMigrationSucceeded?: (message: string) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  single?: boolean;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const migrateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);
  // 父级刷新会清空选择；弹窗独立持有会话 ID 和权威基线。保存结果不确定时，
  // 基线会从 PostgreSQL 重新读取，避免把已经落库的部分修改伪装成本地撤销。
  const [sessionItemIds] = useState(() => items.map((item) => item.id));
  const [baselineItems, setBaselineItems] =
    useState<BatchEditableImageSnapshot[]>(() => items);
  const operations = useBatchMetadataOperations({
    initialIds: sessionItemIds,
    onSaved
  });
  const {
    activeIdSet,
    restorableRemovedCount,
    remove,
    readAuthoritativeSnapshot,
    reconcileAvailableItems,
    restoreActiveItems,
    save,
    saveStatus,
    saveSummary
  } = operations;
  const saving = saveStatus.pending;
  const deleteStatus = useAsyncActionStatus({ successDurationMs: null });
  const [deleteError, setDeleteError] = useState("");
  const busy = saving || deleteStatus.pending;
  const [drafts, setDrafts] = useState<Record<string, ImageDraft>>(
    () => draftsFromImages(items)
  );
  const [preview, setPreview] = useState<{ src: string; thumbSrc: string; width: number; height: number } | null>(null);
  const [page, setPage] = useState(1);

  const [common, setCommon] = useState(emptyCommonAttributes);
  const [commonExpanded, setCommonExpanded] = useState(false);
  const [restoreConfirmation, setRestoreConfirmation] = useState(false);
  const [baselineRefreshRequired, setBaselineRefreshRequired] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const permissions = useAdminPermissions();
  const canMigrateStorage = permissions.includes(
    adminPermissions.imageStorageMigrate
  );
  const { data: storageOptionsData } = useStorageOptions();
  // 列表行左下角的「所在存储」展示后端显示名。
  const resolveStorageName = storageNameResolver(storageOptionsData?.backends ?? []);
  const activeItems = baselineItems.filter((item) => activeIdSet.has(item.id));
  const totalPages = Math.max(1, Math.ceil(activeItems.length / pageSize));
  const visibleItems = activeItems.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => setPage((current) => Math.min(current, totalPages)), [totalPages]);
  const patchDraft = (id: string, patch: Partial<ImageDraft>) => setDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));

  const changedByItem = new Map(activeItems.map((item) => [
    item.id,
    fieldsChangedFor(item, drafts[item.id])
  ]));
  const changedCount = activeItems.filter((item) => Object.values(changedByItem.get(item.id)!).some(Boolean)).length;
  const savePresentation = {
    idle: !single && changedCount
      ? { label: `保存${changedCount}项` }
      : { icon: "save-3-line" as const, label: "保存" },
    pending: { icon: "save-3-line", label: "保存中" },
    success: { icon: "check-line", label: "保存成功" },
    error: { icon: "close-line", label: "保存失败" }
  } as const;
  const modalSubtitle = single ? (baselineItems[0]?.object_key ?? "") : `${activeItems.length} 张图片`;

  const commonChanged = { device: common.device !== "", brightness: common.brightness !== "", theme: common.theme.trim() !== "", author: common.author.trim() !== "", tags: common.tags.length > 0 };
  const commonHasValue = commonChanged.device || commonChanged.brightness || commonChanged.theme || commonChanged.author || commonChanged.tags;
  const restoreAvailable = changedCount > 0
    || commonHasValue
    || restorableRemovedCount > 0
    || baselineRefreshRequired
    || Boolean(saveSummary);
  const commonSummary = [
    batchCommonDeviceOptions.find((option) => option.value === common.device)?.label ?? "设备不变",
    batchCommonBrightnessOptions.find((option) => option.value === common.brightness)?.label ?? "亮暗不变",
    facetDisplayName(themes, common.theme, "主题不变"),
    facetDisplayName(authors, common.author, "作者不变"),
    `${common.tags.length} 个标签`,
  ].join(" · ");
  const reconcileAuthoritativeBaseline = async () => {
    setBaselineRefreshRequired(true);
    const snapshot = await readAuthoritativeSnapshot();
    if (!snapshot) return null;
    setBaselineItems(snapshot.items);
    reconcileAvailableItems(snapshot.items.map((item) => item.id));
    setBaselineRefreshRequired(false);
    return snapshot.items;
  };
  const saveAll = async () => {
    const changedItems = activeItems.flatMap((item) => {
      const changed = changedByItem.get(item.id)!;
      if (!Object.values(changed).some(Boolean)) return [];
      return [changedMetadataUpdate(item, drafts[item.id], changed)];
    });
    if (!changedItems.length) return false;

    setBaselineRefreshRequired(true);
    return save(changedItems, reconcileAuthoritativeBaseline);
  };
  const restoreAllChanges = async () => {
    let restoreItems = baselineItems;
    if (baselineRefreshRequired) {
      const refreshed = await reconcileAuthoritativeBaseline();
      if (!refreshed) return false;
      restoreItems = refreshed;
    }
    restoreActiveItems(restoreItems.map((item) => item.id));
    setDrafts(draftsFromImages(restoreItems));
    setCommon(emptyCommonAttributes());
    return true;
  };
  const deleteSingleImage = async (requestClose: () => void) => {
    const item = activeItems[0];
    if (!single || !item || busy) return;

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
        await onDeleted?.(item.id);
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
      ariaLabel={single ? "编辑图片" : "批量编辑图片"}
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
        className={`batch-edit-modal${single ? " is-single" : ""}`}
        tabIndex={-1}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          if (await saveAll()) requestClose();
        }}
      >
        <header>
          <div>
            <h2>{single ? "编辑图片" : "批量编辑图片"}</h2>
            <p title={single ? modalSubtitle : undefined}>{modalSubtitle}</p>
          </div>
          <div className="batch-edit-header-actions">
            {!single && (
              <button
                ref={restoreTriggerRef}
                className="batch-edit-restore-button"
                type="button"
                title="撤销所有未保存修改"
                disabled={busy || !restoreAvailable}
                onClick={() => setRestoreConfirmation(true)}
              >
                <AdminIcon name="history-line" />复原
              </button>
            )}
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
        {!single && (
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
              onApply={() => setDrafts((current) => Object.fromEntries(
                Object.entries(current).map(([id, draft]) => {
                  if (!activeIdSet.has(id)) return [id, draft];
                  return [id, mergeBatchEditCommonAttributes(draft, common)];
                })
              ))}
            />
          </WorkflowCollapsePanel>
        )}
        <div className="modal-scroll-list batch-edit-list" ref={listRef}>
          {deleteError && (
            <p className="batch-edit-delete-error" role="alert">
              {deleteError}
            </p>
          )}
          {saveSummary && <BatchMetadataSaveSummary summary={saveSummary} />}
          {visibleItems.map((item) => {
            const draft = drafts[item.id];
            const changed = changedByItem.get(item.id)!;
            const cardChanged = Object.values(changed).some(Boolean);
            return (
              <article key={item.id} className={`batch-edit-row${cardChanged ? " is-changed" : ""}`}>
                <div className="batch-edit-preview">
                  <ImageThumbnail src={item.thumb_url} onClick={(opener) => {
                    previewReturnFocusRef.current = opener;
                    setPreview({ src: item.object_url, thumbSrc: item.thumb_url, width: item.width, height: item.height });
                  }} />
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
                        {cardChanged && <span className="changed-badge">已修改</span>}
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
                    {!single && (
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
          {!activeItems.length && <p className="empty-state">批量编辑列表为空</p>}
        </div>
        {!single && (
          <AdminPagination
            className="batch-edit-pagination"
            ariaLabel="批量编辑分页"
            page={page}
            totalPages={totalPages}
            disabled={busy}
            onPageChange={setPage}
          />
        )}
        <footer>
          {(canMigrateStorage || single) && (
            <div className="batch-edit-resource-actions">
              {canMigrateStorage && (
                <button
                  ref={migrateTriggerRef}
                  className="batch-edit-migrate-trigger"
                  type="button"
                  disabled={busy || !activeItems.length}
                  {...preloadIntentProps(preloadBatchStorageMigrationDialog)}
                  onClick={() => setMigrating(true)}
                >
                  <AdminIcon name="arrow-left-right-line" />{single ? "迁移存储" : "批量迁移存储"}
                </button>
              )}
              {single && (
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
          {!single && (
            <AdminPagination
              className="batch-edit-footer-pagination"
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
              className={`button workflow-submit-button${single ? "" : " batch-edit-save-button"}`}
              type="submit"
              status={saveStatus.status}
              presentation={savePresentation}
              disabled={busy || !changedCount}
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
            single={single}
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
          description="将撤销本弹窗中尚未保存的属性修改，并恢复从批量编辑列表移出的图片；已经保存的修改不会回退。"
          confirmLabel="确认复原"
          pendingLabel="复原中"
          successLabel="已复原"
          danger={false}
          confirmIcon="history-line"
          closeOnBackdrop
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
