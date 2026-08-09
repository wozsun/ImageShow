import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  adminPermissions,
  type AdminEntityListResponseDto,
  type AdminPermission
} from "@imageshow/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiClientError } from "../../lib/api/client.js";
import { AdminIcon } from "../../components/icon/AdminIcon.js";
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
import { useAdminSettings } from "../../lib/api/admin-settings.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import {
  reorderItemByDirection,
  reorderItemByKey,
  reorderPositionByKey,
  type ReorderDirection
} from "../../lib/ui/reorder.js";
import type { Author, Tag, Theme } from "../../lib/types.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { invalidateImageData } from "../../lib/api/query-invalidation.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";
import { useAdminPermissions } from "../../hooks/useAuthSession.js";
import { useReorderControlFocus } from "../../hooks/useReorderControlFocus.js";
import "../../styles/admin/entity.css";

type EntityKind = "tags" | "themes" | "authors";
type Entity = Tag | Theme | Author;
type EntityMutation = "" | "delete";

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
const DELETE_PERMISSIONS = {
  tags: adminPermissions.tagDelete,
  themes: adminPermissions.themeDelete,
  authors: adminPermissions.authorDelete
} satisfies Record<EntityKind, AdminPermission>;

export function EntityAdmin({ kind }: { kind: EntityKind }) {
  const copy = COPY[kind];
  const isAuthor = kind === "authors";
  const queryKey = QUERY_KEYS[kind];
  const permissions = useAdminPermissions();
  const canDelete = permissions.includes(DELETE_PERMISSIONS[kind]);
  const client = useQueryClient();
  const { data, error: listError, isError: listFailed, isFetching, refetch } = useQuery<AdminEntityListResponseDto>({ queryKey, queryFn: ({ signal }) => api(`${adminApiBasePath}/${kind}`, { signal }) });
  const { data: settingsData } = useAdminSettings();
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
  const [page, setPage] = useState(1);
  const [reordering, setReordering] = useState(false);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");

  const [order, setOrder] = useState<Entity[]>([]);
  const orderRef = useRef<Entity[]>([]);
  const dragSlug = useRef<string | null>(null);
  const dragStartOrder = useRef<Entity[]>([]);
  const reorderRunning = useRef(false);
  const reorderFeedbackId = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (reorderRunning.current || dragSlug.current) return;
    const items = data?.items ?? [];
    orderRef.current = items;
    setOrder(items);
  }, [data]);
  useEffect(() => {
    if (canDelete) return;
    setConfirmDelete(null);
  }, [canDelete]);

  const slugInvalid = slug.length > 0 && !slugPattern.test(slug);
  const slugError = slugInvalid ? slugFormatHint : createError;
  const operationBusy = Boolean(mutation) || createAction.pending || reordering;

  const pageSize = settingsData?.settings.admin.image_page_size ?? adminImagePageLimit;
  const isFixedEntity = (item: Entity) => (
    kind === "themes" && item.slug === "none"
  );
  // 主题页可隐藏钉住的「未设置 / none」占位卡片（设置页 admin 组的开关，默认显示）；其它类别无此卡片。
  // 只过滤展示用列表，order（含 none）保持完整，拖拽排序逻辑不受影响。
  const showUnsetCard = settingsData?.settings.admin.show_unset_theme_card ?? true;
  const visibleItems = kind === "themes" && !showUnsetCard
    ? order.filter((item) => item.slug !== "none")
    : order;
  const totalPages = Math.max(1, Math.ceil(visibleItems.length / pageSize));
  const pageItems = visibleItems.slice((page - 1) * pageSize, page * pageSize);
  const {
    registerReorderControl,
    requestReorderFocus
  } = useReorderControlFocus({
    itemSlugs: visibleItems.map((item) => item.slug),
    page,
    pageSize,
    onPageChange: setPage
  });
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
    if (!canDelete || !confirmDelete) return false;
    setMutation("delete");
    try {
      await api(`${adminApiBasePath}/${kind}/${confirmDelete.slug}/delete`, { method: "POST" });
      await refresh();
      return true;
    } catch (err) {
      reportAdminUiError(`entity_admin.${kind}.delete`, err);
      return false;
    } finally {
      setMutation("");
    }
  };

  const replaceOrder = (items: Entity[]) => {
    orderRef.current = items;
    setOrder(items);
  };

  const positionText = (items: Entity[], movedSlug: string) => {
    const position = reorderPositionByKey(
      items,
      movedSlug,
      (item) => item.slug,
      isFixedEntity
    );
    return position
      ? `可排序项第 ${position.position} / ${position.total} 位`
      : "当前位置不可用";
  };

  const itemName = (items: Entity[], movedSlug: string) => {
    const item = items.find((candidate) => candidate.slug === movedSlug);
    return `${copy.noun}“${item?.display_name || movedSlug}”`;
  };

  const showReorderFeedback = (
    text: string,
    status: "pending" | "success" | "error"
  ) => {
    const nextFeedback = createActionFeedback(text, status);
    reorderFeedbackId.current = nextFeedback.id;
    setFeedback(nextFeedback);
    setReorderAnnouncement(text);
  };

  const persistOrder = async ({
    nextOrder,
    previousOrder,
    movedSlug,
    focusDirection
  }: {
    nextOrder: Entity[];
    previousOrder: Entity[];
    movedSlug: string;
    focusDirection: ReorderDirection | null;
  }) => {
    if (
      reorderRunning.current
      || mutation
      || createAction.pending
    ) return;

    reorderRunning.current = true;
    setReordering(true);
    replaceOrder(nextOrder);
    if (focusDirection) {
      requestReorderFocus(movedSlug, focusDirection);
    }
    showReorderFeedback("正在保存排序...", "pending");

    try {
      let saveSucceeded = false;
      try {
        const slugs = nextOrder
          .filter((item) => !isFixedEntity(item))
          .map((item) => item.slug);
        await api(`${adminApiBasePath}/${kind}/reorder`, {
          method: "POST",
          body: JSON.stringify({ slugs })
        });
        saveSucceeded = true;
      } catch (error) {
        reportAdminUiError(`entity_admin.${kind}.reorder`, error);
      }

      let authoritativeOrder = saveSucceeded ? nextOrder : previousOrder;
      try {
        await refresh();
      } catch (error) {
        reportAdminUiError(`entity_admin.${kind}.reorder_refresh`, error);
      }

      const queryState = client.getQueryState(queryKey);
      const cached = client.getQueryData<AdminEntityListResponseDto>(queryKey);
      const refreshed = Boolean(
        cached
        && queryState?.status === "success"
        && !queryState.isInvalidated
      );
      if (refreshed && cached) {
        authoritativeOrder = cached.items;
      }

      replaceOrder(authoritativeOrder);
      if (focusDirection) {
        requestReorderFocus(movedSlug, focusDirection);
      }
      const actualPosition = positionText(authoritativeOrder, movedSlug);
      const label = itemName(authoritativeOrder, movedSlug);
      const message = saveSucceeded
        ? `${label}排序已保存，当前为${actualPosition}`
        : refreshed && cached
          ? `${label}排序保存失败，已按服务器顺序恢复到${actualPosition}`
          : `${label}排序保存失败，已恢复到上次已知的${actualPosition}`;
      showReorderFeedback(
        message,
        saveSucceeded ? "success" : "error"
      );
    } finally {
      reorderRunning.current = false;
      setReordering(false);
    }
  };

  const moveByKeyboard = (
    movedSlug: string,
    direction: ReorderDirection
  ) => {
    if (operationBusy || reorderRunning.current) return;
    const previousOrder = orderRef.current;
    const result = reorderItemByDirection(
      previousOrder,
      movedSlug,
      direction,
      (item) => item.slug,
      isFixedEntity
    );
    if (!result.moved) return;
    void persistOrder({
      nextOrder: result.items,
      previousOrder,
      movedSlug,
      focusDirection: direction
    });
  };

  const beginDrag = (movedSlug: string) => {
    if (operationBusy || reorderRunning.current) return;
    dragSlug.current = movedSlug;
    dragStartOrder.current = orderRef.current;
  };

  const moveOver = (targetSlug: string) => {
    const from = dragSlug.current;
    if (!from || operationBusy || reorderRunning.current) return;
    const result = reorderItemByKey(
      orderRef.current,
      from,
      targetSlug,
      (item) => item.slug,
      isFixedEntity
    );
    if (result.moved) replaceOrder(result.items);
  };

  const finishDrag = () => {
    const movedSlug = dragSlug.current;
    dragSlug.current = null;
    if (!movedSlug) return;
    const previousOrder = dragStartOrder.current;
    dragStartOrder.current = [];
    const nextOrder = orderRef.current;
    if (operationBusy || reorderRunning.current) {
      replaceOrder(
        client.getQueryData<AdminEntityListResponseDto>(queryKey)?.items
          ?? previousOrder
      );
      return;
    }
    const changed = previousOrder.some(
      (item, index) => item.slug !== nextOrder[index]?.slug
    ) || previousOrder.length !== nextOrder.length;
    if (!changed) {
      replaceOrder(
        client.getQueryData<AdminEntityListResponseDto>(queryKey)?.items
          ?? previousOrder
      );
      return;
    }
    void persistOrder({
      nextOrder,
      previousOrder,
      movedSlug,
      focusDirection: null
    });
  };

  return (
    <section className="workspace workspace-paged">
      <WorkspaceHeader
        title={`${copy.noun}管理`}
        description={`第 ${page} / ${totalPages} 页 · 共 ${visibleItems.length} 个${copy.noun}${isFetching ? " · 加载中" : ""} · ${copy.headHint} · 可用前移/后移按钮，桌面端也可拖动排序`}
        feedbackTarget={feedbackTarget}
      />
      <p
        className="reorder-live-region"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {reorderAnnouncement}
      </p>
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
          {slugError && <p className="admin-field-error" role="alert">{slugError}</p>}
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
          <AdminIcon name="add-line" />
          <StableButtonLabel
            idle={`新建${copy.noun}`}
            busyText="新建中"
            busy={createAction.pending}
          />
        </button>
      </form>
      {feedback && (
        <ActionFeedbackOutlet
          feedback={feedback}
          target={feedbackTarget}
          announce={feedback.id !== reorderFeedbackId.current}
          onClose={() => setFeedback(null)}
        />
      )}
      <div className="admin-scroll-region" ref={listRef}>
        <div className="entity-admin-grid entity-vocabulary-grid">
          {pageItems.map((item) => {
            const position = reorderPositionByKey(
              order,
              item.slug,
              (candidate) => candidate.slug,
              isFixedEntity
            );
            return (
              <EntityAdminCard
                key={item.slug}
                kind={kind}
                item={item}
                pinned={isFixedEntity(item)}
                canDelete={canDelete}
                reorderBusy={operationBusy}
                canMovePrevious={Boolean(position && position.position > 1)}
                canMoveNext={Boolean(
                  position && position.position < position.total
                )}
                onMove={(direction) => moveByKeyboard(item.slug, direction)}
                onReorderControlRef={(direction, node) => {
                  registerReorderControl(item.slug, direction, node);
                }}
                onChanged={() => void refresh()}
                onDelete={() => setConfirmDelete(item)}
                onError={(error) => reportAdminUiError(`entity_admin.${kind}.update`, error)}
                onDragStart={beginDrag}
                onDragEnter={moveOver}
                onDragEnd={finishDrag}
              />
            );
          })}
          {listFailed && <QueryErrorState error={listError} onRetry={() => void refetch()} reportContext={`entity_admin.${kind}.load`} />}
          {!listFailed && !order.length && !isFetching && <p className="muted">{copy.empty}</p>}
        </div>
      </div>
      <OverlayScrollbar targetRef={listRef} pageEdge />
      <AdminPagination
        ariaLabel={`${copy.noun}分页`}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
      />
      {canDelete && confirmDelete && (
        <ConfirmDialog
          title={`删除${copy.noun}`}
          description={copy.deleteDescription(confirmDelete)}
          confirmLabel="确认删除"
          requireFinalConfirmation
          finalConfirmationLabel="再次确认"
          busy={mutation === "delete"}
          onClose={() => setConfirmDelete(null)}
          onConfirm={remove}
        />
      )}
    </section>
  );
}
