import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api/client.js";
import { Icon } from "../../components/icon/Icon.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { ConfirmDialog } from "../../components/feedback/ConfirmDialog.js";
import { EntityCard } from "../../components/data-display/EntityCard.js";
import { PageToast } from "../../components/feedback/PageToast.js";
import { adminApiBasePath, queryKeys, slugCharset, slugFormatHint } from "../../lib/constants.js";
import { errorMessage } from "../../lib/ui/formatters.js";
import type { AdminSettings, Author, Tag, Theme } from "../../lib/types.js";

type EntityKind = "tags" | "themes" | "authors";
type Entity = Tag | Theme | Author;

const COPY = {
  tags: {
    noun: "标签",
    headHint: "显示名可用于打标签时解析",
    slugPlaceholder: "标签 slug",
    displayPlaceholder: "显示名（可选）",
    empty: "还没有标签",
    deleteDescription: (item: Entity) => `删除标签「${item.display_name || item.slug}」，会从 ${item.image_count} 张图片上移除该标签，此操作无法撤销。`
  },
  themes: {
    noun: "主题",
    headHint: "显示名可用于主题搜索",
    slugPlaceholder: "主题 slug",
    displayPlaceholder: "显示名（可选）",
    empty: "还没有主题（上传图片或在上方新建）",
    deleteDescription: (item: Entity) => `删除主题「${item.display_name || item.slug}」，其 ${item.image_count} 张图片将归为「未设置」，此操作无法撤销。`
  },
  authors: {
    noun: "作者",
    headHint: "显示名可用于作者搜索，链接显示在图片详情",
    slugPlaceholder: "作者 slug",
    displayPlaceholder: "显示名（可选）",
    empty: "还没有作者（上传图片或在上方新建）",
    deleteDescription: (item: Entity) => `删除作者「${item.display_name || item.slug}」，其 ${item.image_count} 张图片的作者属性将被清除，此操作无法撤销。`
  }
} as const;

const QUERY_KEYS = { tags: queryKeys.tags, themes: queryKeys.themes, authors: queryKeys.authors } as const;

export function EntityAdmin({ kind }: { kind: EntityKind }) {
  const copy = COPY[kind];
  const isAuthor = kind === "authors";
  const queryKey = QUERY_KEYS[kind];
  const client = useQueryClient();
  const { data, isFetching } = useQuery<{ items: Entity[] }>({ queryKey, queryFn: () => api(`${adminApiBasePath}/${kind}`) });
  const { data: settingsData } = useQuery<{ settings: AdminSettings }>({ queryKey: queryKeys.settings, queryFn: () => api(`${adminApiBasePath}/settings`) });
  // 新建/删除词条会改动公共画廊的筛选词表（gallery-options，staleTime:Infinity 不会自动刷新），
  // 删除还会清除关联图片上的该属性，故一并失效后台图片列表，与 ImageAdmin.refresh 的失效集对齐。
  const refresh = () => {
    client.invalidateQueries({ queryKey });
    client.invalidateQueries({ queryKey: queryKeys.galleryOptions });
    client.invalidateQueries({ queryKey: queryKeys.adminImages });
  };
  const [slug, setSlug] = useState("");
  const [display, setDisplay] = useState("");

  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Entity | null>(null);
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);

  const [order, setOrder] = useState<Entity[]>([]);
  const dragSlug = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setOrder(data?.items ?? []); }, [data]);

  const slugInvalid = slug.length > 0 && !slugCharset.test(slug);

  const pageSize = settingsData?.settings.admin.image_page_size ?? 50;
  // 主题页可隐藏钉住的「未设置 / none」占位卡片（设置页 admin 组的开关，默认显示）；其它类别无此卡片。
  // 只过滤展示用列表，order（含 none）保持完整，拖拽排序逻辑不受影响。
  const showUnsetCard = settingsData?.settings.admin.show_unset_theme_card ?? true;
  const visibleItems = kind === "themes" && !showUnsetCard
    ? order.filter((item) => item.slug !== "none")
    : order;
  const totalPages = Math.max(1, Math.ceil(visibleItems.length / pageSize));
  const pageItems = visibleItems.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => { setPage((current) => Math.min(current, totalPages)); }, [totalPages]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const value = slug.trim().toLowerCase();
    if (!value || busy || slugInvalid) return;
    setBusy(true);
    setError("");
    try {
      const body = isAuthor ? { slug: value, display_name: display.trim(), link: link.trim() } : { slug: value, display_name: display.trim() };
      await api(`${adminApiBasePath}/${kind}`, { method: "POST", body: JSON.stringify(body) });
      setSlug("");
      setDisplay("");
      setLink("");
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      await api(`${adminApiBasePath}/${kind}/${confirmDelete.slug}/delete`, { method: "POST" });
      setConfirmDelete(null);
      setSelected((current) => current.filter((s) => s !== confirmDelete.slug));
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const removeSelected = async () => {
    if (!selected.length) return;
    setBusy(true);
    try {
      await api(`${adminApiBasePath}/${kind}/batch-delete`, { method: "POST", body: JSON.stringify({ slugs: selected }) });
      setConfirmBatch(false);
      setSelected([]);
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleSelect = (s: string, checked: boolean) => setSelected((current) => checked ? [...new Set([...current, s])] : current.filter((x) => x !== s));

  const moveOver = (targetSlug: string) => {
    const from = dragSlug.current;
    if (!from || from === targetSlug || from === "none" || targetSlug === "none") return;
    setOrder((current) => {
      const fromIdx = current.findIndex((item) => item.slug === from);
      const toIdx = current.findIndex((item) => item.slug === targetSlug);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return current;
      const next = [...current];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };

  const persistOrder = async () => {
    if (!dragSlug.current) return;
    dragSlug.current = null;
    const slugs = order.filter((item) => item.slug !== "none").map((item) => item.slug);
    try {
      await api(`${adminApiBasePath}/${kind}/reorder`, { method: "POST", body: JSON.stringify({ slugs }) });
      refresh();
    } catch (err) {
      setError(errorMessage(err));
      refresh();
    }
  };

  return (
    <section className="workspace workspace-paged">
      <header className="workspace-head">
        <div>
          <h1>{copy.noun}管理</h1>
          <p>第 {page} / {totalPages} 页 · 共 {visibleItems.length} 个{copy.noun}{isFetching ? " · 加载中" : ""} · {copy.headHint}</p>
        </div>
      </header>
      <form className="theme-create-form" onSubmit={create}>
        <div className="theme-create-field entity-slug-field">
          <input
            className="entity-create-slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value.toLowerCase())}
            placeholder={copy.slugPlaceholder}
            disabled={busy}
            maxLength={32}
            aria-invalid={slugInvalid}
          />
          {slugInvalid && <p className="field-error">{slugFormatHint}</p>}
        </div>
        <input
          value={display}
          onChange={(event) => setDisplay(event.target.value)}
          placeholder={copy.displayPlaceholder}
          disabled={busy}
          maxLength={64}
        />
        {isAuthor && (
          <input
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="链接 URL（http(s)，可选）"
            disabled={busy}
            maxLength={2048}
          />
        )}
        <button className="button" type="submit" disabled={busy || !slug.trim() || slugInvalid}>
          <Icon name="add-line" />新建{copy.noun}
        </button>
        <button
          className="danger-button"
          type="button"
          disabled={busy || !selected.length}
          onClick={() => setConfirmBatch(true)}
        >
          <Icon name="delete-bin-6-line" />批量删除{selected.length ? `（${selected.length}）` : ""}
        </button>
      </form>
      <PageToast message={error} onClose={() => setError("")} />
      <div className="entity-admin-grid admin-scroll-region" ref={listRef}>
        {pageItems.map((item) => (
          <EntityCard
            key={item.slug}
            kind={kind}
            item={item}
            pinned={item.slug === "none"}
            selected={selected.includes(item.slug)}
            onToggleSelect={(checked) => toggleSelect(item.slug, checked)}
            onChanged={refresh}
            onDelete={() => setConfirmDelete(item)}
            onError={setError}
            onDragStart={(s) => { dragSlug.current = s; }}
            onDragEnter={moveOver}
            onDragEnd={persistOrder}
          />
        ))}
        {!order.length && !isFetching && <p className="muted">{copy.empty}</p>}
      </div>
      <OverlayScrollbar targetRef={listRef} pageEdge />
      <nav className="admin-pagination" aria-label={`${copy.noun}分页`}>
        <button type="button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</button>
        <span>第 {page} / {totalPages} 页</span>
        <button type="button" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>下一页</button>
      </nav>
      {confirmDelete && (
        <ConfirmDialog
          title={`删除${copy.noun}`}
          description={copy.deleteDescription(confirmDelete)}
          confirmLabel="删除"
          busy={busy}
          onClose={() => setConfirmDelete(null)}
          onConfirm={remove}
        />
      )}
      {confirmBatch && (
        <ConfirmDialog
          title={`批量删除${copy.noun}`}
          description={kind === "tags"
            ? `删除选中的 ${selected.length} 个标签，并从相关图片上移除，此操作无法撤销。`
            : kind === "authors"
              ? `删除选中的 ${selected.length} 个作者，相关图片的作者属性将被清除，此操作无法撤销。`
              : `删除选中的 ${selected.length} 个${copy.noun}，它们的图片都将归为「未设置」，此操作无法撤销。`}
          confirmLabel="删除"
          busy={busy}
          onClose={() => setConfirmBatch(false)}
          onConfirm={removeSelected}
        />
      )}
    </section>
  );
}
