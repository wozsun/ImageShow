import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiClientError } from "../../lib/api/client.js";
import { Icon } from "../../components/icon/Icon.js";
import { StableButtonLabel } from "../../components/data-display/StableButtonLabel.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { AdminPagination } from "../../components/navigation/AdminPagination.js";
import { ConfirmDialog } from "../../components/feedback/ConfirmDialog.js";
import {
  createActionFeedback,
  type ActionFeedbackState
} from "../../components/feedback/ActionFeedback.js";
import {
  ActionFeedbackOutlet,
  useActionFeedbackTarget
} from "../../components/feedback/ActionFeedbackRegion.js";
import { WorkspaceHeader } from "../../components/layout/WorkspaceHeader.js";
import { EntityAdminCard } from "./EntityAdminCard.js";
import {
  adminApiBasePath,
  adminImagePageLimit,
  slugFormatHint,
  slugPattern
} from "../../lib/constants.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import type { AdminSettings, Author, Tag, Theme } from "../../lib/types.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { invalidateImageData } from "../../lib/api/query-invalidation.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";

type EntityKind = "tags" | "themes" | "authors";
type Entity = Tag | Theme | Author;
type EntityMutation = "" | "delete" | "batch-delete";

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
  const { data, error: listError, isError: listFailed, isFetching, refetch } = useQuery<{ items: Entity[] }>({ queryKey, queryFn: ({ signal }) => api(`${adminApiBasePath}/${kind}`, { signal }) });
  const { data: settingsData } = useQuery<{ settings: AdminSettings }>({ queryKey: queryKeys.settings, queryFn: ({ signal }) => api(`${adminApiBasePath}/settings`, { signal }) });
  // 新建/删除词条会改动公共画廊的筛选词表（gallery-facets，staleTime:Infinity 不会自动刷新），
  // 删除还会清除关联图片上的该属性，故一并失效后台图片列表，与 ImageAdmin.refresh 的失效集对齐。
  const refresh = () => invalidateImageData(client);
  const [slug, setSlug] = useState("");
  const [display, setDisplay] = useState("");

  const [link, setLink] = useState("");
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const feedbackTarget = useActionFeedbackTarget(`${kind}-admin`);
  const [mutation, setMutation] = useState<EntityMutation>("");
  const [createError, setCreateError] = useState("");
  const createAction = useAsyncActionStatus({ resultDurationMs: null });
  const [confirmDelete, setConfirmDelete] = useState<Entity | null>(null);
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);

  const [order, setOrder] = useState<Entity[]>([]);
  const dragSlug = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const showOperationError = (error: unknown, context: string) => {
    reportAdminUiError(context, error);
    setFeedback(createActionFeedback(`${copy.noun}操作失败，请稍后重试`, "error"));
  };

  useEffect(() => { setOrder(data?.items ?? []); }, [data]);

  const slugInvalid = slug.length > 0 && !slugPattern.test(slug);
  const slugError = slugInvalid ? slugFormatHint : createError;
  const operationBusy = Boolean(mutation) || createAction.pending;

  const pageSize = settingsData?.settings.admin.image_page_size ?? adminImagePageLimit;
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
    if (!value || operationBusy || slugInvalid) return;
    if (order.some((item) => item.slug === value)) {
      setCreateError(`该${copy.noun}已存在`);
      return;
    }

    setCreateError("");
    setFeedback(null);
    await createAction.run(async () => {
      try {
        const body = isAuthor
          ? { slug: value, display_name: display.trim(), link: link.trim() }
          : { slug: value, display_name: display.trim() };
        await api(`${adminApiBasePath}/${kind}`, {
          method: "POST",
          body: JSON.stringify(body)
        });
        setSlug("");
        setDisplay("");
        setLink("");
        await refresh();
        return true;
      } catch (error) {
        reportAdminUiError(`entity_admin.${kind}.create`, error);
        setCreateError(
          isApiClientError(error) && (error.status === 409 || error.code.endsWith("_exists"))
            ? `该${copy.noun}已存在`
            : `${copy.noun}创建失败，请稍后重试`
        );
        return false;
      }
    });
  };

  const remove = async () => {
    if (!confirmDelete) return false;
    setMutation("delete");
    try {
      await api(`${adminApiBasePath}/${kind}/${confirmDelete.slug}/delete`, { method: "POST" });
      setSelected((current) => current.filter((s) => s !== confirmDelete.slug));
      await refresh();
      return true;
    } catch (err) {
      reportAdminUiError(`entity_admin.${kind}.delete`, err);
      return false;
    } finally {
      setMutation("");
    }
  };

  const removeSelected = async () => {
    if (!selected.length) return false;
    setMutation("batch-delete");
    try {
      await api(`${adminApiBasePath}/${kind}/batch-delete`, { method: "POST", body: JSON.stringify({ slugs: selected }) });
      setSelected([]);
      await refresh();
      return true;
    } catch (err) {
      reportAdminUiError(`entity_admin.${kind}.batch_delete`, err);
      return false;
    } finally {
      setMutation("");
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
    const persistedOrder = data?.items ?? [];
    const slugs = order.filter((item) => item.slug !== "none").map((item) => item.slug);
    try {
      await api(`${adminApiBasePath}/${kind}/reorder`, { method: "POST", body: JSON.stringify({ slugs }) });
      await refresh();
    } catch (err) {
      setOrder(persistedOrder);
      showOperationError(err, `entity_admin.${kind}.reorder`);
      void refresh();
    }
  };

  return (
    <section className="workspace workspace-paged">
      <WorkspaceHeader
        title={`${copy.noun}管理`}
        description={`第 ${page} / ${totalPages} 页 · 共 ${visibleItems.length} 个${copy.noun}${isFetching ? " · 加载中" : ""} · ${copy.headHint}`}
        feedbackTarget={feedbackTarget}
      />
      <form className="admin-create-form" onSubmit={create}>
        <div className="admin-create-field entity-slug-field">
          <input
            className="entity-create-slug"
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value.toLowerCase());
              setCreateError("");
            }}
            placeholder={copy.slugPlaceholder}
            disabled={operationBusy}
            maxLength={32}
            aria-invalid={Boolean(slugError)}
          />
          {slugError && <p className="field-error" role="alert">{slugError}</p>}
        </div>
        <input
          value={display}
          onChange={(event) => setDisplay(event.target.value)}
          placeholder={copy.displayPlaceholder}
          disabled={operationBusy}
          maxLength={64}
        />
        {isAuthor && (
          <input
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="链接 URL（HTTPS，可选）"
            disabled={operationBusy}
            maxLength={2048}
          />
        )}
        <button
          className="button"
          type="submit"
          disabled={operationBusy || !slug.trim() || slugInvalid}
        >
          <Icon name="add-line" />
          <StableButtonLabel
            idle={`新建${copy.noun}`}
            busyText="新建中"
            busy={createAction.pending}
          />
        </button>
        <button
          className="danger-button"
          type="button"
          disabled={operationBusy || !selected.length}
          onClick={() => setConfirmBatch(true)}
        >
          <Icon name="delete-bin-6-line" />批量删除{selected.length ? `（${selected.length}）` : ""}
        </button>
      </form>
      {feedback && (
        <ActionFeedbackOutlet
          feedback={feedback}
          target={feedbackTarget}
          onClose={() => setFeedback(null)}
        />
      )}
      <div className="admin-scroll-region" ref={listRef}>
        <div className="entity-admin-grid">
          {pageItems.map((item) => (
            <EntityAdminCard
              key={item.slug}
              kind={kind}
              item={item}
              pinned={item.slug === "none"}
              selected={selected.includes(item.slug)}
              onToggleSelect={(checked) => toggleSelect(item.slug, checked)}
              onChanged={() => void refresh()}
              onDelete={() => setConfirmDelete(item)}
              onError={(error) => reportAdminUiError(`entity_admin.${kind}.update`, error)}
              onDragStart={(s) => { dragSlug.current = s; }}
              onDragEnter={moveOver}
              onDragEnd={persistOrder}
            />
          ))}
          {listFailed && <QueryErrorState error={listError} onRetry={() => void refetch()} reportContext={`entity_admin.${kind}.load`} />}
          {!listFailed && !order.length && !isFetching && <p className="muted">{copy.empty}</p>}
        </div>
      </div>
      <OverlayScrollbar targetRef={listRef} pageEdge />
      <AdminPagination
        ariaLabel={`${copy.noun}分页`}
        page={page}
        totalPages={totalPages}
        onPrevious={() => setPage((current) => Math.max(1, current - 1))}
        onNext={() => setPage((current) => Math.min(totalPages, current + 1))}
      />
      {confirmDelete && (
        <ConfirmDialog
          title={`删除${copy.noun}`}
          description={copy.deleteDescription(confirmDelete)}
          confirmLabel="删除"
          busy={mutation === "delete"}
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
          busy={mutation === "batch-delete"}
          onClose={() => setConfirmBatch(false)}
          onConfirm={removeSelected}
        />
      )}
    </section>
  );
}
