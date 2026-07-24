import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from "react";
import { adminPermissions } from "@imageshow/shared/browser";
import { Icon } from "../../components/icon/Icon.js";
import { AsyncActionButton } from "../../components/actions/AsyncActionButton.js";
import { DialogFrame } from "../../components/feedback/DialogFrame.js";
import { WorkflowDefaultFields } from "../../components/form/WorkflowDefaultFields.js";
import { WorkflowCollapsePanel } from "../../components/layout/WorkflowCollapsePanel.js";
import { ImageThumbnail } from "../../components/image/ImageThumbnail.js";
import { ImagePreviewModal } from "../../components/image/ImagePreviewModal.js";
import { AdminPagination } from "../../components/navigation/AdminPagination.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { ImageDraftFields } from "../../components/form/ImageDraftFields.js";
import { useAdminPermissions } from "../../lib/api/site-data.js";
import { facetDisplayName, formatBytes, formatDimensions, shortImageId } from "../../lib/ui/formatters.js";
import { batchCommonBrightnessOptions, batchCommonDeviceOptions, cardBrightnessSelectOptions, editCardDeviceSelectOptions } from "../../lib/ui/select-options.js";
import { storageNameResolver, useStorageOptions } from "../../lib/api/storage-options.js";
import type { Brightness, Device, FacetOption, ImageDraft, ImageItem } from "../../lib/types.js";
import { mergeBatchEditCommonAttributes, normalizeAuthor, normalizeTheme } from "../../lib/upload/upload-utils.js";
import { BatchMetadataSaveSummary } from "./BatchMetadataSaveSummary.js";
import {
  useBatchMetadataOperations,
  type BatchMetadataUpdate
} from "./useBatchMetadataOperations.js";

const loadBatchStorageMigrationDialog = () => import("./BatchStorageMigrationDialog.js");
const preloadBatchStorageMigrationDialog = () => {
  void loadBatchStorageMigrationDialog().catch(() => undefined);
};
const BatchStorageMigrationDialog = lazy(() => loadBatchStorageMigrationDialog().then((module) => ({
  default: module.BatchStorageMigrationDialog
})));

type BatchMetadataChanges = Record<keyof ImageDraft, boolean>;

function tagsChanged(draftTags: string[], savedTags: string[]) {
  return JSON.stringify([...draftTags].sort()) !== JSON.stringify([...savedTags].sort());
}

function fieldsChangedFor(item: ImageItem, draft: ImageDraft): BatchMetadataChanges {
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
  item: ImageItem,
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
  returnFocusRef,
  single = false
}: {
  items: ImageItem[];
  pageSize: number;
  themes: FacetOption[];
  allTags: FacetOption[];
  authors: FacetOption[];
  onClose: () => void;
  onSaved: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  single?: boolean;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const migrateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);
  // 保存成功后父级会刷新列表并清空选择。弹窗必须继续持有打开时的图片快照，
  // 否则部分成功会让仍失败的项目连同草稿一起从弹窗中消失。
  const [initialItems] = useState(() => items);
  const operations = useBatchMetadataOperations({
    initialIds: initialItems.map((item) => item.id),
    onSaved
  });
  const {
    activeIdSet,
    remove,
    save,
    saveStatus,
    saveSummary
  } = operations;
  const saving = saveStatus.pending;
  const [drafts, setDrafts] = useState<Record<string, ImageDraft>>(() => Object.fromEntries(initialItems.map((item) => [item.id, {
    title: item.title,
    description: item.description,
    source: item.source,
    original: item.original,
    device: item.device,
    brightness: item.brightness,
    theme: item.theme === "none" ? "" : item.theme,
    author: item.author === "none" ? "" : item.author,
    tags: item.tags
  }])));
  const [preview, setPreview] = useState<{ src: string; thumbSrc: string; width: number; height: number } | null>(null);
  const [page, setPage] = useState(1);

  const [common, setCommon] = useState({ device: "" as "" | "auto" | Device, brightness: "" as "" | "auto" | Brightness, theme: "", author: "", tags: [] as string[] });
  const [commonExpanded, setCommonExpanded] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const permissions = useAdminPermissions();
  const canMigrateStorage = permissions.includes(
    adminPermissions.imageStorageMigrate
  );
  const { data: storageOptionsData } = useStorageOptions();
  // 列表行左下角的「所在存储」展示后端显示名。
  const resolveStorageName = storageNameResolver(storageOptionsData?.backends ?? []);
  const activeItems = initialItems.filter((item) => activeIdSet.has(item.id));
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
    idle: {
      icon: "save-3-line",
      label: !single && changedCount ? `保存 (${changedCount})` : "保存"
    },
    pending: { icon: "save-3-line", label: "保存中" },
    success: { icon: "check-line", label: "保存成功" },
    error: { icon: "close-line", label: "保存失败" }
  } as const;
  const modalSubtitle = single ? (initialItems[0]?.object_key ?? "") : `${activeItems.length} 张图片`;

  const commonChanged = { device: common.device !== "", brightness: common.brightness !== "", theme: common.theme.trim() !== "", author: common.author.trim() !== "", tags: common.tags.length > 0 };
  const commonHasValue = commonChanged.device || commonChanged.brightness || commonChanged.theme || commonChanged.author || commonChanged.tags;
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
      return [changedMetadataUpdate(item, drafts[item.id], changed)];
    });
    if (!changedItems.length) return false;

    return save(changedItems);
  };
  return (
    <DialogFrame
      className="modal edit-modal batch-edit-overlay"
      ariaLabel={single ? "编辑图片" : "批量编辑图片"}
      busy={saving}
      paused={Boolean((canMigrateStorage && migrating) || preview)}
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
          if (await saveAll()) requestClose();
        }}
      >
        <header>
          <div>
            <h2>{single ? "编辑图片" : "批量编辑图片"}</h2>
            <p title={single ? modalSubtitle : undefined}>{modalSubtitle}</p>
          </div>
          <button
            ref={closeButtonRef}
            className="icon close pressable"
            type="button"
            title="关闭"
            disabled={saving}
            onClick={() => requestClose()}
          >
            <Icon name="close-line" />
          </button>
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
              applyDisabled={saving}
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
                        disabled={saving}
                        onClick={() => remove(item.id)}
                      >
                        <Icon name="close-line" />
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
                  disabled={saving}
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
            disabled={saving}
            onPrevious={() => setPage((value) => value - 1)}
            onNext={() => setPage((value) => value + 1)}
          />
        )}
        <footer>
          {canMigrateStorage && (
            <button
              ref={migrateTriggerRef}
              className="batch-edit-migrate-trigger"
              type="button"
              disabled={saving || !activeItems.length}
              onPointerEnter={preloadBatchStorageMigrationDialog}
              onPointerDown={preloadBatchStorageMigrationDialog}
              onFocus={preloadBatchStorageMigrationDialog}
              onClick={() => setMigrating(true)}
            >
              <Icon name="arrow-left-right-line" />{single ? "迁移存储" : "批量迁移存储"}
            </button>
          )}
          {!single && (
            <AdminPagination
              className="batch-edit-footer-pagination"
              ariaLabel="批量编辑分页"
              page={page}
              totalPages={totalPages}
              disabled={saving}
              onPrevious={() => setPage((value) => value - 1)}
              onNext={() => setPage((value) => value + 1)}
            />
          )}
          <div className="modal-footer-actions">
            <button type="button" disabled={saving} onClick={() => requestClose()}>取消</button>
            <AsyncActionButton
              className="button workflow-submit-button"
              type="submit"
              status={saveStatus.status}
              presentation={savePresentation}
              disabled={saving || !changedCount}
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
            single={single}
            returnFocusRef={migrateTriggerRef}
            onClose={() => setMigrating(false)}
            onSaved={onSaved}
            onSucceeded={() => {
              setMigrating(false);
              requestClose();
            }}
          />
        </Suspense>
      )}
      {preview && <ImagePreviewModal src={preview.src} thumbSrc={preview.thumbSrc} width={preview.width} height={preview.height} onClose={() => setPreview(null)} returnFocusRef={previewReturnFocusRef} />}
      </>
      )}
    </DialogFrame>
  );
}
