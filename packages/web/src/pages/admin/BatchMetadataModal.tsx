import { useEffect, useRef, useState, type RefObject } from "react";
import { api } from "../../lib/api/client.js";
import { Icon } from "../../components/icon/Icon.js";
import { WorkflowCollapsePanel } from "../../components/layout/WorkflowCollapsePanel.js";
import { ImageThumbnail } from "../../components/image/ImageThumbnail.js";
import { ImagePreviewModal } from "../../components/image/ImagePreviewModal.js";
import { AdminPagination } from "../../components/navigation/AdminPagination.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import { ThemeInput } from "../../components/form/ThemeInput.js";
import { TagInput } from "../../components/form/TagInput.js";
import { AuthorInput } from "../../components/form/AuthorInput.js";
import { ImageDraftFields } from "../../components/form/ImageDraftFields.js";
import { useAnimatedClose } from "../../hooks/useAnimatedClose.js";
import { useBodyScrollLock } from "../../hooks/useBodyScrollLock.js";
import { useDialogFocus } from "../../hooks/useDialogFocus.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { facetDisplayName, formatBytes, formatDimensions, shortImageId } from "../../lib/ui/formatters.js";
import { batchCommonBrightnessOptions, batchCommonDeviceOptions, cardBrightnessSelectOptions, editCardDeviceSelectOptions } from "../../lib/ui/select-options.js";
import { storageNameResolver, useStorageOptions } from "../../lib/api/storage-options.js";
import type { Brightness, Device, FacetOption, ImageDraft, ImageItem } from "../../lib/types.js";
import { mergeBatchEditCommonAttributes, normalizeAuthor, normalizeTheme } from "../../lib/upload/upload-utils.js";

type BatchMetadataChanges = Record<keyof ImageDraft, boolean>;
type BatchMetadataUpdate = { id: string } & Partial<ImageDraft>;
type BatchUpdateItemResult =
  | { id: string; status: "updated" }
  | { id: string; status: "failed"; code: string; message: string };
type BatchUpdateResponse = {
  updated: number;
  failed: number;
  results: BatchUpdateItemResult[];
};
type BatchStorageMigrationResponse = {
  migrated: number;
  unchanged: number;
  failed: number;
};

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
  const exit = useAnimatedClose(onClose);
  useBodyScrollLock();
  const listRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLFormElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const migrateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const migrateDialogRef = useRef<HTMLFormElement | null>(null);
  const migrateCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);
  // 保存成功后父级会刷新列表并清空选择。弹窗必须继续持有打开时的图片快照，
  // 否则部分成功会让仍失败的项目连同草稿一起从弹窗中消失。
  const [initialItems] = useState(() => items);
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveSummary, setSaveSummary] = useState<BatchUpdateResponse | null>(null);

  const [preview, setPreview] = useState<{ src: string; thumbSrc: string; width: number; height: number } | null>(null);
  const [page, setPage] = useState(1);
  const [activeIds, setActiveIds] = useState(() => initialItems.map((item) => item.id));

  const [common, setCommon] = useState({ device: "" as "" | "auto" | Device, brightness: "" as "" | "auto" | Brightness, theme: "", author: "", tags: [] as string[] });
  const [commonExpanded, setCommonExpanded] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migrateTarget, setMigrateTarget] = useState<string>("");
  const [migrateBusy, setMigrateBusy] = useState(false);
  const [migrateError, setMigrateError] = useState("");
  const { data: storageOptionsData } = useStorageOptions();
  const migrateOptions = (storageOptionsData?.backends ?? []).map((backend) => ({ value: backend.slug, label: backend.display_name || backend.slug }));
  // 列表行左下角的「所在存储」展示后端显示名；复用上面已为迁移目标选择器取到的后端列表。
  const resolveStorageName = storageNameResolver(storageOptionsData?.backends ?? []);
  const activeSet = new Set(activeIds);
  const activeItems = initialItems.filter((item) => activeSet.has(item.id));
  const totalPages = Math.max(1, Math.ceil(activeItems.length / pageSize));
  const visibleItems = activeItems.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => setPage((current) => Math.min(current, totalPages)), [totalPages]);
  const patchDraft = (id: string, patch: Partial<ImageDraft>) => setDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));

  const changedByItem = new Map(activeItems.map((item) => [
    item.id,
    fieldsChangedFor(item, drafts[item.id])
  ]));
  const changedCount = activeItems.filter((item) => Object.values(changedByItem.get(item.id)!).some(Boolean)).length;
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
  useDialogFocus({
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    returnFocusRef,
    onEscape: () => exit.requestClose(),
    paused: Boolean(migrating || preview),
  });
  useDialogFocus({
    containerRef: migrateDialogRef,
    initialFocusRef: migrateCloseButtonRef,
    returnFocusRef: migrateTriggerRef,
    onEscape: () => { if (!migrateBusy) setMigrating(false); },
    active: migrating,
  });
  const saveAll = async () => {
    const changedItems = activeItems.flatMap((item) => {
      const changed = changedByItem.get(item.id)!;
      if (!Object.values(changed).some(Boolean)) return [];
      return [changedMetadataUpdate(item, drafts[item.id], changed)];
    });
    if (!changedItems.length) return;

    setSaving(true);
    setError("");
    setSaveSummary(null);
    try {
      const response = await api<BatchUpdateResponse>(`${adminApiBasePath}/images/batch-update`, {
        method: "POST",
        body: JSON.stringify({ items: changedItems }),
      });
      setSaveSummary(response);
      const updatedIds = new Set(
        response.results
          .filter((result) => result.status === "updated")
          .map((result) => result.id)
      );
      if (updatedIds.size) {
        setActiveIds((current) => current.filter((id) => !updatedIds.has(id)));
        onSaved();
      }
      if (!response.failed) exit.requestClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const runBatchMigrate = async () => {
    setMigrateBusy(true);
    setError("");
    setMigrateError("");
    try {
      const response = await api<BatchStorageMigrationResponse>(
        `${adminApiBasePath}/images/batch-migrate-storage`,
        {
          method: "POST",
          body: JSON.stringify({ ids: activeIds, target: migrateTarget }),
        },
      );
      if (response.migrated) onSaved();
      if (response.failed) {
        const outcome = response.migrated || response.unchanged
          ? "迁移未全部完成"
          : "迁移失败";
        setMigrateError(
          `${outcome}：已迁移 ${response.migrated} 项，无需迁移 ${response.unchanged} 项，失败 ${response.failed} 项。请检查存储配置后重试。`,
        );
        return;
      }
      setMigrating(false);
      exit.requestClose();
    } catch (err) {
      setMigrateError((err as Error).message);
    } finally {
      setMigrateBusy(false);
    }
  };
  return (
    <>
    <div
      className={`modal edit-modal batch-edit-overlay ${exit.closing ? "is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={single ? "编辑图片" : "批量编辑图片"}
      onAnimationEnd={exit.onAnimationEnd}
    >
      <form
        ref={dialogRef}
        className={`batch-edit-modal${single ? " is-single" : ""}`}
        tabIndex={-1}
        onSubmit={async (event) => { event.preventDefault(); await saveAll(); }}
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
            onClick={() => exit.requestClose()}
          >
            <Icon name="close-line" />
          </button>
        </header>
        {!single && (
          <WorkflowCollapsePanel
            className="batch-edit-common-panel"
            contentClassName="batch-edit-common"
            title="批量默认属性"
            summary={commonSummary}
            expanded={commonExpanded}
            onExpandedChange={setCommonExpanded}
          >
            <SelectMenu
              className={`batch-common-select${commonChanged.device ? " is-changed" : ""}`}
              value={common.device}
              onChange={(value) => setCommon({ ...common, device: value as "" | "auto" | Device })}
              options={batchCommonDeviceOptions}
              ariaLabel="批量设备"
            />
            <SelectMenu
              className={`batch-common-select${commonChanged.brightness ? " is-changed" : ""}`}
              value={common.brightness}
              onChange={(value) => setCommon({ ...common, brightness: value as "" | "auto" | Brightness })}
              options={batchCommonBrightnessOptions}
              ariaLabel="批量亮度"
            />
            <div className="batch-common-pair">
              <ThemeInput
                className={`batch-common-theme${commonChanged.theme ? " is-changed" : ""}`}
                value={common.theme}
                onChange={(theme) => setCommon({ ...common, theme })}
                themes={themes}
                placeholder="主题不变"
                ariaLabel="批量主题"
              />
              <AuthorInput
                className={`batch-common-author${commonChanged.author ? " is-changed" : ""}`}
                value={common.author}
                onChange={(author) => setCommon({ ...common, author })}
                authors={authors}
                placeholder="作者不变"
                ariaLabel="批量作者"
              />
              <TagInput
                className={`batch-common-tags${commonChanged.tags ? " is-changed" : ""}`}
                value={common.tags}
                onChange={(tags) => setCommon({ ...common, tags })}
                suggestions={allTags}
                placeholder="追加标签"
                ariaLabel="批量标签"
              />
            </div>
            <button
              type="button"
              className={`apply-to-all-button${commonHasValue ? " is-ready" : ""}`}
              disabled={saving}
              onClick={() => setDrafts((current) => Object.fromEntries(Object.entries(current).map(([id, draft]) => {
                if (!activeSet.has(id)) return [id, draft];
                return [id, mergeBatchEditCommonAttributes(draft, common)];
              })))}
            >
              应用到全部
            </button>
          </WorkflowCollapsePanel>
        )}
        <div className="modal-scroll-list batch-edit-list" ref={listRef}>
          {saveSummary && (
            <div className="notice-line batch-edit-save-summary" role="status">
              保存完成：成功 {saveSummary.updated} 项，失败 {saveSummary.failed} 项。
              {saveSummary.results
                .filter((result): result is Extract<BatchUpdateItemResult, { status: "failed" }> => result.status === "failed")
                .map((result) => (
                  <div className="error" key={result.id}>
                    {result.id}：{result.message}（{result.code}）
                  </div>
                ))}
            </div>
          )}
          {error && <p className="error batch-edit-error">{error}</p>}
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
                  {item.is_link
                    ? (
                      <span className="batch-edit-preview-size proxy-image-note" title="代理链接图片">
                        <Icon name="external-link-line" />代理链接
                      </span>
                    )
                    : item.image_size
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
                        {item.is_link ? "代理链接" : item.image_size ? formatBytes(item.image_size) : "大小未记录"} · {resolveStorageName(item)}
                      </span>
                    </div>
                    {!single && (
                      <button
                        className="icon danger-button"
                        type="button"
                        title="从批量编辑中移除"
                        disabled={saving}
                        onClick={() => setActiveIds((current) => current.filter((id) => id !== item.id))}
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
          <button
            ref={migrateTriggerRef}
            className="batch-edit-migrate-trigger"
            type="button"
            disabled={saving || !activeItems.length}
            onClick={() => {
              setMigrateError("");
              setMigrating(true);
              if (!migrateTarget && migrateOptions.length) {
                setMigrateTarget(storageOptionsData?.backends.find((backend) => backend.is_default)?.slug ?? migrateOptions[0].value);
              }
            }}
          >
            <Icon name="arrow-left-right-line" />{single ? "迁移存储" : "批量迁移存储"}
          </button>
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
            <button type="button" disabled={saving} onClick={() => exit.requestClose()}>取消</button>
            <button className="button workflow-submit-button" type="submit" disabled={saving || !changedCount}>
              {saving ? "保存中" : (!single && changedCount) ? `保存 (${changedCount})` : "保存"}
            </button>
          </div>
        </footer>
      </form>
      <OverlayScrollbar targetRef={listRef} />
    </div>
    {migrating && (
      <div
        className="modal edit-modal"
        role="dialog"
        aria-modal="true"
        aria-label={single ? "迁移存储" : "批量迁移存储"}
      >
        <form
          ref={migrateDialogRef}
          className="operation-modal"
          tabIndex={-1}
          onSubmit={async (event) => { event.preventDefault(); await runBatchMigrate(); }}
        >
          <header>
            <div>
              <h2>{single ? "迁移存储" : "批量迁移存储"}</h2>
              <p>{single ? "将这张图片迁移到目标存储后端。" : `将这批 ${activeItems.length} 张图片迁移到目标存储后端。`}</p>
            </div>
            <button
              ref={migrateCloseButtonRef}
              className="icon close pressable"
              type="button"
              title="关闭"
              disabled={migrateBusy}
              onClick={() => setMigrating(false)}
            >
              <Icon name="close-line" />
            </button>
          </header>
          <div className="operation-body">
            <label>
              目标存储
              <SelectMenu
                className="is-storage-select"
                value={migrateTarget}
                onChange={(value) => setMigrateTarget(value)}
                options={migrateOptions}
                ariaLabel="目标存储"
              />
            </label>
            <p className="notice-line">迁移会复制对象与缩略图到目标后端、更新引用，并删除源副本；目标为对象存储时需先在设置页配置好该后端。</p>
            {migrateError && <p className="error" role="alert" title={migrateError}>{migrateError}</p>}
          </div>
          <footer>
            <button type="button" disabled={migrateBusy} onClick={() => setMigrating(false)}>取消</button>
            <button className="button" type="submit" disabled={migrateBusy || !migrateTarget}>
              <Icon name="arrow-left-right-line" />{migrateBusy ? "迁移中" : "开始迁移"}
            </button>
          </footer>
        </form>
      </div>
    )}
    {preview && <ImagePreviewModal src={preview.src} thumbSrc={preview.thumbSrc} width={preview.width} height={preview.height} onClose={() => setPreview(null)} returnFocusRef={previewReturnFocusRef} />}
    </>
  );
}
