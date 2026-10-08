import {
  imageVariantUrl,
  storageObjectKey,
  adminPermissions,
  type Brightness,
  type Device,
  type FacetOptionDto,
  type EditableImageSnapshotDto,
  type ImageDraftDto
} from "@imageshow/shared/browser";
import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from "react";
import { AdminIcon } from "../../icon/AdminIcon.js";
import { AsyncActionButton } from "../../actions/AsyncActionButton.js";
import { ConfirmDialog } from "../../dialog/ConfirmDialog.js";
import { TwoStepConfirmButton } from "../../actions/TwoStepConfirmButton.js";
import { DialogFrame } from "../../dialog/DialogFrame.js";
import { WorkflowDefaultFields } from "../../form/WorkflowDefaultFields.js";
import { WorkflowCollapsePanel } from "../../layout/WorkflowCollapsePanel.js";
import { ImagePreviewModal } from "../ImagePreviewModal.js";
import { AdminPagination } from "../../navigation/AdminPagination.js";
import { OverlayScrollbar } from "../../layout/OverlayScrollbar.js";
import { useAsyncActionStatus } from "../../../hooks/useAsyncActionStatus.js";
import { useAdminPermissions } from "../../../hooks/useAuthSession.js";
import { createPageLifetimeModuleLoader } from "../../../lib/page-lifetime-module-loader.js";
import { facetDisplayName } from "../../../lib/ui/formatters.js";
import { preloadIntentProps } from "../../../lib/ui/preload-intent.js";
import {
  commonImageBrightnessOptions,
  commonImageDeviceOptions
} from "../../../lib/ui/select-options.js";
import { storageNameResolver, useStorageOptions } from "../../../lib/api/storage-options.js";
import {
  imageAttributeClearPatch,
  mergeCommonImageAttributes,
  type PrepareImageAttributeClear
} from "../../../lib/image-draft.js";
import { useImageMetadataOperations } from "./useImageMetadataOperations.js";
import {
  changedMetadataUpdate,
  createImageMetadataSession,
  fieldsChangedFor,
  reconcileImageMetadataSession,
  restoreImageMetadataDrafts
} from "./image-metadata-session.js";
import { ImageMetadataEditorCard } from "./ImageMetadataEditorCard.js";
import { useImageEditorTrashAction } from "./useImageEditorTrashAction.js";
import type {
  ImageEditorIntent,
  ImageEditorSavedHandler
} from "./image-editor-types.js";

type ImageStorageMigrationDialogModule = typeof import("./ImageStorageMigrationDialog.js");

const loadImageStorageMigrationDialog =
  createPageLifetimeModuleLoader<ImageStorageMigrationDialogModule>(
    () => import("./ImageStorageMigrationDialog.js")
  );
const preloadImageStorageMigrationDialog = () => {
  void loadImageStorageMigrationDialog().catch(() => undefined);
};
const ImageStorageMigrationDialog = lazy(() =>
  loadImageStorageMigrationDialog().then((module) => ({
    default: module.ImageStorageMigrationDialog
  }))
);

function emptyCommonAttributes() {
  return {
    device: "" as "" | "auto" | Device,
    brightness: "" as "" | "auto" | Brightness,
    theme: "",
    author: "",
    tags: [] as string[]
  };
}

export function ImageMetadataEditorDialog({
  items,
  intent = "edit",
  fromDialog = false,
  pageSize,
  themes,
  allTags,
  authors,
  onClose,
  onTrashCommitted,
  publicImageMembershipHandled = false,
  onSaved,
  onMembershipChange,
  onStorageMigrationSucceeded,
  returnFocusRef
}: {
  items: EditableImageSnapshotDto[];
  intent?: ImageEditorIntent;
  fromDialog?: boolean;
  pageSize: number;
  themes: FacetOptionDto[];
  allTags: FacetOptionDto[];
  authors: FacetOptionDto[];
  onClose: () => void;
  onTrashCommitted?: (imageIds: string[]) => void | Promise<void>;
  publicImageMembershipHandled?: boolean;
  onSaved?: ImageEditorSavedHandler;
  onMembershipChange?: (ids: string[]) => Promise<{ complete: boolean; message: string }>;
  onStorageMigrationSucceeded?: (
    message: string,
    storageLabel: string
  ) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const singleItem = items.length === 1;
  const multipleItems = items.length > 1;
  const readOnly = intent !== "edit";
  const membership = intent === "group-add" || intent === "group-remove";
  const membershipLabel = intent === "group-add" ? "加入分组" : "移出分组";
  const membershipAction = useAsyncActionStatus({ minimumPendingMs: 0, resultDurationMs: null });
  const [membershipResult, setMembershipResult] = useState<string | null>(null);
  const membershipSubmittedRef = useRef(false);
  const deleting = intent === "delete";
  const title = membership ? membershipLabel : deleting
    ? singleItem ? "删除图片" : "批量删除图片"
    : singleItem ? "编辑图片" : "批量编辑图片";
  const listRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const migrateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);
  // 父级刷新可能清空选择或因筛选移除图片；弹窗独立持有固定会话 ID、活动成员、
  // PostgreSQL 权威基线和草稿，保存留窗期间不再从父列表重建状态。
  const [sessionItemIds] = useState(() => items.map((item) => item.id));
  const [session, setSession] = useState(() => createImageMetadataSession(items));
  const trashAction = useImageEditorTrashAction({
    setSession,
    onTrashCommitted: (ids) => onTrashCommitted?.(ids),
    publicImageMembershipHandled
  });
  const operations = useImageMetadataOperations({
    initialIds: sessionItemIds,
    onSaved: (commit) => onSaved?.(commit)
  });
  const { pendingReconciliation, reconcilePendingSave, save, saveStatus, lastSaveReport } =
    operations;
  const saving = saveStatus.pending;
  const busy = saving || trashAction.pending || membershipAction.pending;
  const [preview, setPreview] = useState<{
    src: string;
    thumbSrc: string;
    width: number;
    height: number;
  } | null>(null);
  const [page, setPage] = useState(1);

  const [common, setCommon] = useState(emptyCommonAttributes);
  const [commonExpanded, setCommonExpanded] = useState(false);
  const [restoreConfirmation, setRestoreConfirmation] = useState(false);
  const [restoreError, setRestoreError] = useState("");
  const [migrating, setMigrating] = useState(false);
  const permissions = useAdminPermissions();
  const canMigrateStorage = permissions.includes(adminPermissions.imageStorageMigrate);
  const { data: storageOptionsData } = useStorageOptions();
  // 列表行左下角的「所在存储」展示后端显示名。
  const resolveStorageName = storageNameResolver(storageOptionsData?.backends ?? []);
  const activeIdSet = new Set(session.activeIds);
  const activeItems = session.baselineItems.filter((item) => activeIdSet.has(item.id));
  const trashAvailable = activeItems.length > 0;
  const totalPages = Math.max(1, Math.ceil(activeItems.length / pageSize));
  const paginationAvailable = totalPages > 1;
  const visibleItems = activeItems.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => setPage((current) => Math.min(current, totalPages)), [totalPages]);
  const patchDraft = (id: string, patch: Partial<ImageDraftDto>) =>
    setSession((current) => ({
      ...current,
      drafts: {
        ...current.drafts,
        [id]: { ...current.drafts[id], ...patch }
      }
    }));
  const remove = (id: string) =>
    setSession((current) => ({
      ...current,
      activeIds: current.activeIds.filter((candidate) => candidate !== id)
    }));

  const changedByItem = new Map(
    activeItems.map((item) => [
      item.id,
      fieldsChangedFor(item, session.drafts[item.id])
    ])
  );
  const changedCount = activeItems.filter((item) =>
    Object.values(changedByItem.get(item.id)!).some(Boolean)
  ).length;
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
  const modalSubtitle = singleItem
    ? activeItems[0]
      ? storageObjectKey(activeItems[0].id)
      : ""
    : `${activeItems.length} 张图片`;

  const commonChanged = {
    device: common.device !== "",
    brightness: common.brightness !== "",
    theme: common.theme.trim() !== "",
    author: common.author.trim() !== "",
    tags: common.tags.length > 0
  };
  const restoreAvailable = changedCount > 0;
  const commonSummary = [
    commonImageDeviceOptions.find((option) => option.value === common.device)?.label ?? "设备不变",
    commonImageBrightnessOptions.find((option) => option.value === common.brightness)?.label ??
      "亮暗不变",
    facetDisplayName(themes, common.theme, "主题不变"),
    facetDisplayName(authors, common.author, "作者不变"),
    `${common.tags.length} 个标签`
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
      setSession((current) =>
        reconcileImageMetadataSession(
          current,
          outcome.attempt,
          authoritativeItems
        )
      );
    }
    return Boolean(
      outcome &&
      (outcome.report.snapshotFailed ||
        (outcome.report.failed === 0
          && outcome.report.unavailableIds.length === 0))
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
      setSession((current) =>
        restoreImageMetadataDrafts(
          reconcileImageMetadataSession(
            current,
            outcome.attempt,
            authoritativeItems
          )
        )
      );
      return true;
    }
    setSession((current) => restoreImageMetadataDrafts(current));
    return true;
  };
  const trashActiveImages = async (requestClose: () => void) => {
    const imageIds = activeItems.map((item) => item.id);
    if (!imageIds.length || busy) return false;
    const allTrashed = await trashAction.trash(imageIds);
    if (allTrashed) requestClose();
    return allTrashed;
  };
  const changeMembership = async (requestClose: () => void) => {
    if (!onMembershipChange || membershipSubmittedRef.current || busy || !activeItems.length) return;
    membershipSubmittedRef.current = true;
    await membershipAction.run(async () => {
      const result = await onMembershipChange(activeItems.map((item) => item.id));
      if (result.complete) requestClose();
      else setMembershipResult(result.message);
      return result.complete;
    });
  };
  const prepareAttributeClear: PrepareImageAttributeClear = (field) => {
    if (busy) return null;
    const ids = new Set(session.activeIds);
    return {
      count: ids.size,
      apply: async () => {
        const patch = imageAttributeClearPatch(field);
        setSession((current) => ({
          ...current,
          drafts: Object.fromEntries(
            Object.entries(current.drafts).map(([id, draft]) => [
              id,
              ids.has(id) && current.activeIds.includes(id) ? { ...draft, ...patch } : draft
            ])
          )
        }));
      }
    };
  };
  return (
    <DialogFrame
      className={`modal edit-modal is-mobile-fullscreen${fromDialog ? " is-dialog-continuation" : ""}`}
      ariaLabel={title}
      busy={busy}
      paused={Boolean((canMigrateStorage && migrating)
        || preview
        || restoreConfirmation)}
      initialFocusRef={closeButtonRef}
      returnFocusRef={returnFocusRef}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <>
          <form
            className={`image-editor-modal image-workflow-window${singleItem ? " is-single" : ""}${readOnly ? " is-delete" : ""}`}
            tabIndex={-1}
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy || readOnly) return;
              await saveAll();
            }}
          >
            <header>
              <div>
                <h2>{title}</h2>
                <p title={singleItem ? modalSubtitle : undefined}>{modalSubtitle}</p>
              </div>
              <div className="image-editor-header-actions">
                {!readOnly && (
                  <button
                    ref={restoreTriggerRef}
                    className="image-editor-restore-button"
                    type="button"
                    title="撤销所有未保存修改"
                    disabled={busy || !restoreAvailable}
                    onClick={() => {
                      setRestoreError("");
                      setRestoreConfirmation(true);
                    }}
                  >
                    <AdminIcon name="history-line" />
                    复原
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
            {multipleItems && !readOnly && (
              <WorkflowCollapsePanel
                className="image-editor-common-panel"
                contentClassName="image-editor-common workflow-defaults"
                title="批量默认属性"
                summary={commonSummary}
                expanded={commonExpanded}
                onExpandedChange={setCommonExpanded}
              >
                <WorkflowDefaultFields
                  values={common}
                  onChange={{
                    device: (device) =>
                      setCommon({
                        ...common,
                        device: device as "" | "auto" | Device
                      }),
                    brightness: (brightness) =>
                      setCommon({
                        ...common,
                        brightness: brightness as "" | "auto" | Brightness
                      }),
                    theme: (theme) => setCommon({ ...common, theme }),
                    author: (author) => setCommon({ ...common, author }),
                    tags: (tags) => setCommon({ ...common, tags })
                  }}
                  deviceOptions={commonImageDeviceOptions}
                  brightnessOptions={commonImageBrightnessOptions}
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
                  applyDisabled={busy || !activeItems.length}
                  clearScope={sessionItemIds.join(",")}
                  clearScopeLabel="本次批量编辑"
                  onPrepareClear={prepareAttributeClear}
                  onApply={() =>
                    setSession((current) => ({
                      ...current,
                      drafts: Object.fromEntries(
                        Object.entries(current.drafts).map(([id, draft]) => {
                          if (!current.activeIds.includes(id)) return [id, draft];
                          return [id, mergeCommonImageAttributes(draft, common)];
                        })
                      )
                    }))
                  }
                />
              </WorkflowCollapsePanel>
            )}
            <div className="modal-scroll-list image-workflow-list image-editor-list" ref={listRef}>
              {membershipResult && <p className="image-editor-trash-error" role="alert">{membershipResult}</p>}
              {trashAction.errorMessage && (
                <p className="image-editor-trash-error" role="alert">
                  {trashAction.errorMessage}
                </p>
              )}
              {visibleItems.map((item) => (
                <ImageMetadataEditorCard
                  key={item.id}
                  item={item}
                  draft={session.drafts[item.id]}
                  changed={changedByItem.get(item.id)!}
                  lastSaveReport={lastSaveReport}
                  multipleItems={multipleItems}
                  intent={intent}
                  busy={busy}
                  themes={themes}
                  allTags={allTags}
                  authors={authors}
                  storageName={resolveStorageName(item)}
                  onPatch={(patch) => patchDraft(item.id, patch)}
                  onRemove={() => {
                    if (activeItems.length === 1) requestClose();
                    else remove(item.id);
                  }}
                  onPreview={(opener) => {
                    previewReturnFocusRef.current = opener;
                    setPreview({
                      src: imageVariantUrl(item, "medium"),
                      thumbSrc: imageVariantUrl(item, "small"),
                      width: item.variants.medium.width,
                      height: item.variants.medium.height
                    });
                  }}
                />
              ))}
              {!activeItems.length && (
                <p className="image-editor-empty-state">
                  {membership ? "待操作图片列表为空" : deleting ? "图片删除列表为空" : "图片编辑列表为空"}
                </p>
              )}
            </div>
            <footer
              className={`image-workflow-footer${paginationAvailable ? " has-pagination" : ""}`}
            >
              {!readOnly && (canMigrateStorage || trashAvailable) && (
                <div className="image-editor-resource-actions image-workflow-leading-actions">
                  {canMigrateStorage && (
                    <button
                      ref={migrateTriggerRef}
                      className="image-editor-migrate-trigger"
                      type="button"
                      disabled={busy || !activeItems.length}
                      {...preloadIntentProps(preloadImageStorageMigrationDialog)}
                      onClick={() => setMigrating(true)}
                    >
                      <AdminIcon name="arrow-left-right-line" />
                      {multipleItems ? "批量迁移存储" : "迁移存储"}
                    </button>
                  )}
                  {trashAvailable && (
                    <TwoStepConfirmButton
                      className="icon danger-button is-subtle image-editor-trash-trigger"
                      idleIcon="delete-bin-line"
                      confirmIcon="delete-bin-2-line"
                      busyIcon="delete-bin-5-line"
                      idleLabel={
                        multipleItems
                          ? `删除这 ${activeItems.length} 张图片`
                          : "删除此图片"
                      }
                      confirmLabel={
                        multipleItems
                          ? `再次点击确认删除这 ${activeItems.length} 张图片`
                          : "再次点击确认删除此图片"
                      }
                      busyLabel={
                        multipleItems
                          ? `正在删除这 ${activeItems.length} 张图片`
                          : "删除中"
                      }
                      disabled={busy || !activeItems.length}
                      busy={trashAction.pending}
                      onConfirm={() => {
                        trashAction.clearError();
                        void trashActiveImages(requestClose);
                      }}
                    />
                  )}
                </div>
              )}
              {paginationAvailable && (
                <AdminPagination
                  className="image-workflow-pagination"
                  ariaLabel={membership ? "待操作图片分页" : deleting ? "批量删除分页" : "批量编辑分页"}
                  page={page}
                  totalPages={totalPages}
                  disabled={busy}
                  onPageChange={setPage}
                />
              )}
              <div className="modal-footer-actions">
                <button type="button" disabled={busy} onClick={() => requestClose()}>
                  取消
                </button>
                {membership ? (
                  <AsyncActionButton
                    type="button"
                    className={`${intent === "group-add" ? "button" : "danger-button"} workflow-submit-button image-editor-membership-button`}
                    status={membershipAction.status}
                    disabled={busy || !activeItems.length || membershipSubmittedRef.current}
                    presentation={{
                      idle: { icon: intent === "group-add" ? "add-line" : "subtract-line", label: membershipLabel },
                      pending: { icon: "refresh-line", label: "处理中" },
                      success: { icon: "check-line", label: "已完成" },
                      error: { icon: "close-line", label: "未完成" }
                    }}
                    onClick={() => void changeMembership(requestClose)}
                  />
                ) : deleting ? (
                  <TwoStepConfirmButton
                    className="danger-button workflow-submit-button image-editor-delete-button"
                    showLabel
                    idleIcon="delete-bin-line"
                    confirmIcon="delete-bin-2-line"
                    busyIcon="delete-bin-5-line"
                    idleLabel={`删除 ${activeItems.length} 张`}
                    confirmLabel="确认删除"
                    busyLabel="正在删除"
                    disabled={busy || !activeItems.length}
                    busy={trashAction.pending}
                    onConfirm={() => {
                      trashAction.clearError();
                      void trashActiveImages(requestClose);
                    }}
                  />
                ) : (
                  <AsyncActionButton
                    className={`button workflow-submit-button${multipleItems ? " image-editor-save-button" : ""}`}
                    type="submit"
                    status={saveStatus.status}
                    presentation={savePresentation}
                    disabled={busy || (!changedCount && !pendingReconciliation)}
                  />
                )}
              </div>
            </footer>
          </form>
          <OverlayScrollbar targetRef={listRef} />
          {canMigrateStorage && migrating && (
            <Suspense fallback={null}>
              <ImageStorageMigrationDialog
                open
                imageIds={activeItems.map((item) => item.id)}
                currentStorageSlugs={activeItems.map((item) => item.storage_slug)}
                returnFocusRef={migrateTriggerRef}
                onClose={() => setMigrating(false)}
                onSaved={() => onSaved?.()}
                onSucceeded={(message, storageLabel) => {
                  setMigrating(false);
                  onStorageMigrationSucceeded?.(message, storageLabel);
                  requestClose();
                }}
              />
            </Suspense>
          )}
          {preview && (
            <ImagePreviewModal
              src={preview.src}
              thumbSrc={preview.thumbSrc}
              width={preview.width}
              height={preview.height}
              onClose={() => setPreview(null)}
              returnFocusRef={previewReturnFocusRef}
            />
          )}
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
