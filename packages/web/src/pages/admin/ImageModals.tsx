import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.js";
import { Icon } from "../../components/Icon.js";
import { ImageThumbnail } from "../../components/ImageThumbnail.js";
import { OverlayScrollbar } from "../../components/OverlayScrollbar.js";
import { SelectMenu } from "../../components/SelectMenu.js";
import { ThemeInput } from "../../components/ThemeInput.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { useAnimatedClose } from "../../components/useAnimatedClose.js";
import { useBodyScrollLock } from "../../components/useBodyScrollLock.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { formatDimensions, formatImageMeta } from "../../lib/formatters.js";
import { brightnessSelectOptions, deviceSelectOptions, storageBackendLabel, storageBackendSelectOptions } from "../../lib/select-options.js";
import type { Brightness, Device, ImageDraft, ImageItem, StorageBackend } from "../../lib/types.js";
import { applyCommonAttributes, normalizeTheme } from "../../lib/upload-utils.js";

export function BatchMetadataModal({ items, pageSize, themes, onClose, onSaved }: { items: ImageItem[]; pageSize: number; themes: string[]; onClose: () => void; onSaved: () => void }) {
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
    theme: item.theme === "none" ? "" : item.theme
  }])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [activeIds, setActiveIds] = useState(() => items.map((item) => item.id));
  const [common, setCommon] = useState({ device: "" as "" | Device, brightness: "" as "" | Brightness, theme: "" });
  const [migrating, setMigrating] = useState(false);
  const [migrateTarget, setMigrateTarget] = useState<StorageBackend>("s3");
  const [migrateBusy, setMigrateBusy] = useState(false);
  const activeSet = new Set(activeIds);
  const activeItems = items.filter((item) => activeSet.has(item.id));
  const totalPages = Math.max(1, Math.ceil(activeItems.length / pageSize));
  const visibleItems = activeItems.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => setPage((current) => Math.min(current, totalPages)), [totalPages]);
  const patchDraft = (id: string, patch: Partial<ImageDraft>) => setDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  const saveAll = async () => {
    setSaving(true);
    setError("");
    try {
      for (const item of activeItems) {
        const draft = drafts[item.id];
        await api(`${adminApiBasePath}/images/${item.id}`, { method: "POST", body: JSON.stringify({ ...draft, theme: normalizeTheme(draft.theme) }) });
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
    <div className={`modal edit-modal ${exit.closing ? "is-closing" : ""}`} onAnimationEnd={exit.onAnimationEnd} onClick={saving ? undefined : () => exit.requestClose()}>
      <form className="batch-edit-modal" onSubmit={async (event) => { event.preventDefault(); await saveAll(); }} onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>批量编辑图片</h2>
            <p>{activeItems.length} 张图片 · 第 {page} / {totalPages} 页</p>
          </div>
          <button className="icon close pressable" type="button" title="关闭" disabled={saving} onClick={() => exit.requestClose()}><Icon name="close-line" /></button>
        </header>
        <div className="batch-edit-common">
          <SelectMenu value={common.device} onChange={(value) => setCommon({ ...common, device: value as "" | Device })} options={[{ value: "", label: "设备保持不变" }, ...deviceSelectOptions]} ariaLabel="批量设备" />
          <SelectMenu value={common.brightness} onChange={(value) => setCommon({ ...common, brightness: value as "" | Brightness })} options={[{ value: "", label: "亮度保持不变" }, ...brightnessSelectOptions]} ariaLabel="批量亮度" />
          <ThemeInput value={common.theme} onChange={(theme) => setCommon({ ...common, theme })} themes={themes} placeholder="主题保持不变" ariaLabel="批量主题" />
          <button type="button" onClick={() => setDrafts((current) => Object.fromEntries(Object.entries(current).map(([id, draft]) => [id, activeSet.has(id) ? applyCommonAttributes(draft, common) : draft])))}>应用到全部</button>
        </div>
        <div className="modal-scroll-list batch-edit-list" ref={listRef}>
          {visibleItems.map((item) => {
            const draft = drafts[item.id];
            return (
              <article key={item.id} className="batch-edit-row">
                <ImageThumbnail src={item.thumb_url} />
                <div className="batch-edit-content">
                  <div className="batch-edit-head">
                    <div><strong>{item.object_key.split("/").pop()}</strong><span>{formatDimensions(item.width, item.height)} · {item.theme} · {item.device}/{item.brightness} · {storageBackendLabel(item.storage_backend)}</span></div>
                    <button className="icon danger-button" type="button" title="从批量编辑中移除" disabled={saving} onClick={() => setActiveIds((current) => current.filter((id) => id !== item.id))}><Icon name="close-line" /></button>
                  </div>
                  <div className="batch-edit-fields">
                    <input value={draft.title} onChange={(event) => patchDraft(item.id, { title: event.target.value })} placeholder="标题" disabled={saving} />
                    <SelectMenu value={draft.device} onChange={(value) => patchDraft(item.id, { device: value as Device })} disabled={saving} options={deviceSelectOptions} ariaLabel={`${item.title || item.id} 设备`} />
                    <SelectMenu value={draft.brightness} onChange={(value) => patchDraft(item.id, { brightness: value as Brightness })} disabled={saving} options={brightnessSelectOptions} ariaLabel={`${item.title || item.id} 亮度`} />
                    <ThemeInput value={draft.theme} onChange={(theme) => patchDraft(item.id, { theme })} themes={themes} disabled={saving} ariaLabel={`${item.title || item.id} 主题`} />
                    <input value={draft.source} onChange={(event) => patchDraft(item.id, { source: event.target.value })} placeholder="来源 URL" disabled={saving} />
                    <input value={draft.original} onChange={(event) => patchDraft(item.id, { original: event.target.value })} placeholder="原图 URL" disabled={saving} />
                  </div>
                  <textarea value={draft.description} onChange={(event) => patchDraft(item.id, { description: event.target.value })} placeholder="详情描述" disabled={saving} />
                </div>
              </article>
            );
          })}
          {!activeItems.length && <p className="empty-state">批量编辑列表为空</p>}
        </div>
        {error && <p className="error">{error}</p>}
        <footer>
          <button type="button" disabled={saving || !activeItems.length} onClick={() => setMigrating(true)}><Icon name="arrow-left-right-line" />批量迁移存储</button>
          <nav className="admin-pagination" aria-label="批量编辑分页">
            <button type="button" disabled={saving || page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
            <span>{page} / {totalPages}</span>
            <button type="button" disabled={saving || page >= totalPages} onClick={() => setPage((value) => value + 1)}>下一页</button>
          </nav>
          <div className="modal-footer-actions">
            <button type="button" disabled={saving} onClick={() => exit.requestClose()}>取消</button>
            <button className="button" type="submit" disabled={saving || !activeItems.length}><Icon name="save-3-line" />{saving ? "保存中" : "保存"}</button>
          </div>
        </footer>
      </form>
      <OverlayScrollbar targetRef={listRef} />
    </div>
    {migrating && (
      <div className="modal edit-modal" role="dialog" aria-modal="true" aria-label="批量迁移存储" onClick={migrateBusy ? undefined : () => setMigrating(false)}>
        <form className="operation-modal" onSubmit={async (event) => { event.preventDefault(); await runBatchMigrate(); }} onClick={(event) => event.stopPropagation()}>
          <header>
            <div><h2>批量迁移存储</h2><p>将这批 {activeItems.length} 张图片迁移到目标存储后端。</p></div>
            <button className="icon close pressable" type="button" title="关闭" disabled={migrateBusy} onClick={() => setMigrating(false)}><Icon name="close-line" /></button>
          </header>
          <div className="operation-body">
            <label>目标存储<SelectMenu className="is-storage-select" value={migrateTarget} onChange={(value) => setMigrateTarget(value as StorageBackend)} options={storageBackendSelectOptions} ariaLabel="目标存储" /></label>
            <p className="notice-line">迁移会复制对象与缩略图到目标后端、更新引用，并删除源副本；目标为对象存储时需先在设置页配置好对象存储。</p>
          </div>
          <footer>
            <button type="button" disabled={migrateBusy} onClick={() => setMigrating(false)}>取消</button>
            <button className="button" type="submit" disabled={migrateBusy}><Icon name="arrow-left-right-line" />{migrateBusy ? "迁移中" : "开始迁移"}</button>
          </footer>
        </form>
      </div>
    )}
    </>
  );
}

export function ImageEditModal({ item, themes, onClose, onSaved }: { item: ImageItem; themes: string[]; onClose: () => void; onSaved: () => void }) {
  const exit = useAnimatedClose(onClose);
  useBodyScrollLock();
  const [draft, setDraft] = useState<ImageDraft>({
    title: item.title,
    description: item.description,
    source: item.source,
    original: item.original,
    device: item.device,
    brightness: item.brightness,
    theme: item.theme === "none" ? "" : item.theme
  });
  const [error, setError] = useState("");
  const [migrateTarget, setMigrateTarget] = useState<StorageBackend>(item.storage_backend);
  const [migrating, setMigrating] = useState(false);
  const [confirmMigrate, setConfirmMigrate] = useState(false);
  const runMigrate = async () => {
    setMigrating(true);
    setError("");
    try {
      await api(`${adminApiBasePath}/images/${item.id}/migrate-storage`, { method: "POST", body: JSON.stringify({ target: migrateTarget }) });
      setConfirmMigrate(false);
      exit.requestClose(onSaved);
    } catch (err) {
      setConfirmMigrate(false);
      setError((err as Error).message);
    } finally {
      setMigrating(false);
    }
  };
  return (
    <>
    <div className={`modal edit-modal ${exit.closing ? "is-closing" : ""}`} onAnimationEnd={exit.onAnimationEnd} onWheel={(event) => event.preventDefault()} onClick={() => exit.requestClose()}>
      <form onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        try {
          await api(`${adminApiBasePath}/images/${item.id}`, { method: "POST", body: JSON.stringify({ ...draft, theme: normalizeTheme(draft.theme) }) });
          exit.requestClose(onSaved);
        } catch (err) {
          setError((err as Error).message);
        }
      }} onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>编辑图片</h2>
            <p>{formatImageMeta(item)}</p>
          </div>
          <button className="icon close pressable" type="button" title="关闭" onClick={() => exit.requestClose()}><Icon name="close-line" /></button>
        </header>
        <div className="edit-form-grid">
          <div className="edit-image-summary span-all">
            <ImageThumbnail src={item.thumb_url} alt={item.title || item.id} />
            <div><strong>{item.title || item.id}</strong><span>{formatImageMeta(item)}</span></div>
          </div>
          <label>标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <label>设备<SelectMenu value={draft.device} onChange={(value) => setDraft({ ...draft, device: value as Device })} options={deviceSelectOptions} ariaLabel="设备" /></label>
          <label>亮度<SelectMenu value={draft.brightness} onChange={(value) => setDraft({ ...draft, brightness: value as Brightness })} options={brightnessSelectOptions} ariaLabel="亮度" /></label>
          <label>主题<ThemeInput value={draft.theme} onChange={(theme) => setDraft({ ...draft, theme })} themes={themes} /></label>
          <label className="url-field">来源<input value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value })} placeholder="来源 URL" /></label>
          <label className="url-field">原图 URL<input value={draft.original} onChange={(event) => setDraft({ ...draft, original: event.target.value })} placeholder="原图 URL" /></label>
          <label className="span-all">描述<textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        </div>
        <div className="edit-storage">
          <div className="edit-storage-info"><strong>存储位置</strong><span>当前：{storageBackendLabel(item.storage_backend)}</span></div>
          <SelectMenu className="is-storage-select" value={migrateTarget} onChange={(value) => setMigrateTarget(value as StorageBackend)} ariaLabel="目标存储" options={storageBackendSelectOptions} />
          <button type="button" disabled={migrating || migrateTarget === item.storage_backend} onClick={() => setConfirmMigrate(true)}><Icon name="arrow-left-right-line" />{migrating ? "迁移中" : "迁移"}</button>
        </div>
        {error && <p className="error">{error}</p>}
        <footer>
          <button type="button" onClick={() => exit.requestClose()}>取消</button>
          <button className="button" type="submit"><Icon name="save-3-line" />保存</button>
        </footer>
      </form>
    </div>
    {confirmMigrate && <ConfirmDialog title="确认迁移存储" description={`将这张图片迁移到「${storageBackendLabel(migrateTarget)}」？会复制对象与缩略图并更新引用，随后删除源副本。`} confirmLabel="确认迁移" confirmIcon="arrow-left-right-line" danger={false} busy={migrating} onClose={() => setConfirmMigrate(false)} onConfirm={runMigrate} />}
    </>
  );
}
