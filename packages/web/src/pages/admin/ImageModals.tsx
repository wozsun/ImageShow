import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.js";
import { Icon } from "../../components/Icon.js";
import { ImageThumbnail } from "../../components/ImageThumbnail.js";
import { ImagePreview } from "../../components/ImagePreview.js";
import { OverlayScrollbar } from "../../components/OverlayScrollbar.js";
import { SelectMenu } from "../../components/SelectMenu.js";
import { ThemeInput } from "../../components/ThemeInput.js";
import { TagInput } from "../../components/TagInput.js";
import { AuthorInput } from "../../components/AuthorInput.js";
import { ImageDraftFields } from "../../components/ImageDraftFields.js";
import { useAnimatedClose } from "../../components/useAnimatedClose.js";
import { useBodyScrollLock } from "../../components/useBodyScrollLock.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { formatDimensions, formatImageMeta } from "../../lib/formatters.js";
import { batchCommonBrightnessOptions, batchCommonDeviceOptions, cardBrightnessSelectOptions, cardDeviceSelectOptions } from "../../lib/select-options.js";
import { storageNameResolver, useStorageOptions } from "../../lib/storage-options.js";
import type { Author, Brightness, Device, FacetOption, ImageDraft, ImageItem } from "../../lib/types.js";
import { applyCommonAttributes, normalizeAuthor, normalizeTheme } from "../../lib/upload-utils.js";

// Shared by the batch editor and (with single=true) the single-image editor: single mode
// drops the 应用到全部 bar and the pager and trims the wording — so editing one image and
// editing many share all the field logic (the auto-brightness model, the change highlight, save,
// migrate) and read identically.
export function BatchMetadataModal({
  items,
  pageSize,
  themes,
  allTags,
  authors,
  onClose,
  onSaved,
  single = false
}: {
  items: ImageItem[];
  pageSize: number;
  themes: FacetOption[];
  allTags: FacetOption[];
  authors: Author[];
  onClose: () => void;
  onSaved: () => void;
  single?: boolean;
}) {
  const exit = useAnimatedClose(onClose);
  useBodyScrollLock();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ImageDraft>>(() => Object.fromEntries(items.map((item) => [item.id, {
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
  // Click-to-preview a row's full image (its object_url) in a lightbox.
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [activeIds, setActiveIds] = useState(() => items.map((item) => item.id));
  // device "auto" = 自动设备 (resolved per-image at apply); brightness "auto" = 自动亮暗
  // (resolved server-side at save). "" = 不变 (leave the row untouched).
  const [common, setCommon] = useState({ device: "" as "" | "auto" | Device, brightness: "" as "" | "auto" | Brightness, theme: "", author: "", tags: [] as string[] });
  const [migrating, setMigrating] = useState(false);
  const [migrateTarget, setMigrateTarget] = useState<string>("");
  const [migrateBusy, setMigrateBusy] = useState(false);
  const { data: storageOptionsData } = useStorageOptions();
  const migrateOptions = (storageOptionsData?.backends ?? []).map((backend) => ({ value: backend.slug, label: backend.display_name || backend.slug }));
  // 列表行左下角的「所在存储」展示后端显示名；复用上面已为迁移目标选择器取到的后端列表。
  const resolveStorageName = storageNameResolver(storageOptionsData?.backends ?? []);
  const activeSet = new Set(activeIds);
  const activeItems = items.filter((item) => activeSet.has(item.id));
  const totalPages = Math.max(1, Math.ceil(activeItems.length / pageSize));
  const visibleItems = activeItems.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => setPage((current) => Math.min(current, totalPages)), [totalPages]);
  const patchDraft = (id: string, patch: Partial<ImageDraft>) => setDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  const itemsById = new Map(items.map((item) => [item.id, item]));
  // Per-field diff of each draft against its saved image, so edited controls/cards tint
  // amber. theme is normalized ("none" → "") and tags are sorted before comparing, matching
  // what saveAll persists.
  const fieldsChangedFor = (item: ImageItem) => {
    const draft = drafts[item.id];
    return {
      title: draft.title !== item.title,
      description: draft.description !== item.description,
      source: draft.source !== item.source,
      original: draft.original !== item.original,
      device: draft.device !== item.device,
      brightness: draft.brightness !== item.brightness,
      theme: draft.theme !== (item.theme === "none" ? "" : item.theme),
      author: draft.author !== (item.author === "none" ? "" : item.author),
      tags: JSON.stringify([...draft.tags].sort()) !== JSON.stringify([...(item.tags ?? [])].sort())
    };
  };
  const changedByItem = new Map(activeItems.map((item) => [item.id, fieldsChangedFor(item)]));
  const changedCount = activeItems.filter((item) => Object.values(changedByItem.get(item.id)!).some(Boolean)).length;
  // The 应用到全部 bar isn't a diff — flag the inputs that hold a value (so it's clear what a
  // click would write), and light up the button while there's anything to apply.
  const commonChanged = { device: common.device !== "", brightness: common.brightness !== "", theme: common.theme.trim() !== "", author: common.author.trim() !== "", tags: common.tags.length > 0 };
  const commonHasValue = commonChanged.device || commonChanged.brightness || commonChanged.theme || commonChanged.author || commonChanged.tags;
  const saveAll = async () => {
    setSaving(true);
    setError("");
    try {
      for (const item of activeItems) {
        const draft = drafts[item.id];
        await api(`${adminApiBasePath}/images/${item.id}`, { method: "POST", body: JSON.stringify({ ...draft, theme: normalizeTheme(draft.theme), author: normalizeAuthor(draft.author) }) });
        if (JSON.stringify([...draft.tags].sort()) !== JSON.stringify([...(item.tags ?? [])].sort())) {
          await api(`${adminApiBasePath}/images/${item.id}/tags`, { method: "POST", body: JSON.stringify({ tags: draft.tags }) });
        }
      }
      exit.requestClose(onSaved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const runBatchMigrate = async () => {
    setMigrateBusy(true);
    setError("");
    try {
      await api(`${adminApiBasePath}/images/batch-migrate-storage`, { method: "POST", body: JSON.stringify({ ids: activeIds, target: migrateTarget }) });
      setMigrating(false);
      exit.requestClose(onSaved);
    } catch (err) {
      setMigrating(false);
      setError((err as Error).message);
    } finally {
      setMigrateBusy(false);
    }
  };
  return (
    <>
    <div
      className={`modal edit-modal ${exit.closing ? "is-closing" : ""}`}
      onAnimationEnd={exit.onAnimationEnd}
      onClick={saving ? undefined : () => exit.requestClose()}
    >
      <form
        className="batch-edit-modal"
        onSubmit={async (event) => { event.preventDefault(); await saveAll(); }}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2>{single ? "编辑图片" : "批量编辑图片"}</h2>
            <p>{single ? (items[0] ? formatImageMeta(items[0]) : "") : `${activeItems.length} 张图片`}</p>
          </div>
          <button
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
          <div className="batch-edit-common">
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
              <TagInput
                className={`batch-common-tags${commonChanged.tags ? " is-changed" : ""}`}
                value={common.tags}
                onChange={(tags) => setCommon({ ...common, tags })}
                suggestions={allTags}
                placeholder="追加标签"
                ariaLabel="批量标签"
              />
              <AuthorInput
                className={`batch-common-author${commonChanged.author ? " is-changed" : ""}`}
                value={common.author}
                onChange={(author) => setCommon({ ...common, author })}
                authors={authors}
                placeholder="作者不变"
                ariaLabel="批量作者"
              />
            </div>
            <button
              type="button"
              className={`apply-to-all-button${commonHasValue ? " is-ready" : ""}`}
              disabled={saving}
              onClick={() => setDrafts((current) => Object.fromEntries(Object.entries(current).map(([id, draft]) => {
                if (!activeSet.has(id)) return [id, draft];
                // 自动设备 has no per-card option, so resolve it to this image's orientation here
                // (mirroring the uploader); 自动亮暗 stays "auto" and is resolved server-side on save.
                const item = itemsById.get(id);
                const device = common.device === "auto" ? (item && item.width >= item.height ? "pc" : "mb") : common.device;
                return [id, applyCommonAttributes(draft, { ...common, device })];
              })))}
            >
              应用到全部
            </button>
          </div>
        )}
        <div className="modal-scroll-list batch-edit-list" ref={listRef}>
          {visibleItems.map((item) => {
            const draft = drafts[item.id];
            const changed = changedByItem.get(item.id)!;
            const cardChanged = Object.values(changed).some(Boolean);
            return (
              <article key={item.id} className={`batch-edit-row${cardChanged ? " is-changed" : ""}`}>
                <ImageThumbnail src={item.thumb_url} onClick={() => setPreviewSrc(item.object_url)} />
                <div className="batch-edit-content">
                  <div className="batch-edit-head">
                    <div>
                      <div className="batch-edit-head-name">
                        <strong>{item.object_key.split("/").pop()}</strong>
                        {cardChanged && <span className="changed-badge">已修改</span>}
                      </div>
                      <span>{formatDimensions(item.width, item.height)} · {item.theme} · {item.device}/{item.brightness} · {resolveStorageName(item)}</span>
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
                  <ImageDraftFields
                    draft={draft}
                    onPatch={(patch) => patchDraft(item.id, patch)}
                    themes={themes}
                    allTags={allTags}
                    authors={authors}
                    deviceOptions={cardDeviceSelectOptions}
                    brightnessOptions={cardBrightnessSelectOptions}
                    disabled={saving}
                    ariaPrefix={item.title || item.index_key}
                    changed={changed}
                  />
                </div>
              </article>
            );
          })}
          {!activeItems.length && <p className="empty-state">批量编辑列表为空</p>}
        </div>
        {error && <p className="error">{error}</p>}
        <footer>
          <button
            type="button"
            disabled={saving || !activeItems.length}
            onClick={() => {
              setMigrating(true);
              if (!migrateTarget && migrateOptions.length) {
                setMigrateTarget(storageOptionsData?.backends.find((backend) => backend.is_default)?.slug ?? migrateOptions[0].value);
              }
            }}
          >
            <Icon name="arrow-left-right-line" />{single ? "迁移存储" : "批量迁移存储"}
          </button>
          {!single && (
            <nav className="admin-pagination" aria-label="批量编辑分页">
              <button type="button" disabled={saving || page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
              <span>第 {page} / {totalPages} 页</span>
              <button type="button" disabled={saving || page >= totalPages} onClick={() => setPage((value) => value + 1)}>下一页</button>
            </nav>
          )}
          <div className="modal-footer-actions">
            <button type="button" disabled={saving} onClick={() => exit.requestClose()}>取消</button>
            <button className="button" type="submit" disabled={saving || !activeItems.length}>
              <Icon name="save-3-line" />{saving ? "保存中" : (!single && changedCount) ? `保存 (${changedCount})` : "保存"}
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
        onClick={migrateBusy ? undefined : () => setMigrating(false)}
      >
        <form
          className="operation-modal"
          onSubmit={async (event) => { event.preventDefault(); await runBatchMigrate(); }}
          onClick={(event) => event.stopPropagation()}
        >
          <header>
            <div>
              <h2>{single ? "迁移存储" : "批量迁移存储"}</h2>
              <p>{single ? "将这张图片迁移到目标存储后端。" : `将这批 ${activeItems.length} 张图片迁移到目标存储后端。`}</p>
            </div>
            <button
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
          </div>
          <footer>
            <button type="button" disabled={migrateBusy} onClick={() => setMigrating(false)}>取消</button>
            <button className="button" type="submit" disabled={migrateBusy}>
              <Icon name="arrow-left-right-line" />{migrateBusy ? "迁移中" : "开始迁移"}
            </button>
          </footer>
        </form>
      </div>
    )}
    {previewSrc && <ImagePreview src={previewSrc} onClose={() => setPreviewSrc(null)} />}
    </>
  );
}

// Single-image editor: the batch modal with one item and single mode (no apply-to-all bar,
// no pager). A thin wrapper so the call sites stay unchanged and single/batch share all the
// field, save and migrate logic.
export function ImageEditModal({
  item,
  themes,
  allTags,
  authors,
  onClose,
  onSaved
}: {
  item: ImageItem;
  themes: FacetOption[];
  allTags: FacetOption[];
  authors: Author[];
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <BatchMetadataModal
      items={[item]}
      pageSize={1}
      single
      themes={themes}
      allTags={allTags}
      authors={authors}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}
