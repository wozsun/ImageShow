import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  adminPermissions,
  type AuthorDto,
  type AuthorMutationResponseDto,
  type AdminEntityListResponseDto,
  type AdminSettings,
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
  ActionFeedbackOutlet,
  useActionFeedbackTarget
} from "../../components/feedback/ActionFeedbackRegion.js";
import { WorkspaceHeader } from "../../components/layout/WorkspaceHeader.js";
import { VocabularyAdminCard } from "./VocabularyAdminCard.js";
import {
  adminApiBasePath,
  slugFormatHint,
  slugPattern
} from "../../lib/constants.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import { AdminSettingsBoundary } from "../../components/feedback/AdminSettingsBoundary.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import type { Author, Tag, Theme } from "../../lib/types.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import {
  invalidateDataAfterAuthorProfileSave,
  invalidateImageData
} from "../../lib/api/query-invalidation.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";
import { useAdminPermissions } from "../../hooks/useAuthSession.js";
import { usePersistedReorder } from "../../hooks/usePersistedReorder.js";
import "../../styles/admin/entity.css";

type VocabularyKind = "tags" | "themes" | "authors";
type VocabularyEntry = Tag | Theme | Author;
type VocabularyMutation = "" | "delete";

const COPY = {
  tags: {
    noun: "标签",
    slugPlaceholder: "标签 slug",
    displayPlaceholder: "显示名（可选）",
    empty: "还没有标签",
    deleteDescription: (item: VocabularyEntry) => `删除标签「${item.display_name || item.slug}」，会从 ${item.image_count} 张图片上移除该标签，此操作无法撤销。`
  },
  themes: {
    noun: "主题",
    slugPlaceholder: "主题 slug",
    displayPlaceholder: "显示名（可选）",
    empty: "还没有主题（上传图片或在上方新建）",
    deleteDescription: (item: VocabularyEntry) => `删除主题「${item.display_name || item.slug}」，其 ${item.image_count} 张图片将归为「未设置」，此操作无法撤销。`
  },
  authors: {
    noun: "作者",
    slugPlaceholder: "作者 slug",
    displayPlaceholder: "显示名（可选）",
    empty: "还没有作者（上传图片或在上方新建）",
    deleteDescription: (item: VocabularyEntry) => `删除作者「${item.display_name || item.slug}」，其 ${item.image_count} 张图片的作者属性将被清除，此操作无法撤销。`
  }
} as const;

const QUERY_KEYS = { tags: queryKeys.tags, themes: queryKeys.themes, authors: queryKeys.authors } as const;
const DELETE_PERMISSIONS = {
  tags: adminPermissions.tagDelete,
  themes: adminPermissions.themeDelete,
  authors: adminPermissions.authorDelete
} satisfies Record<VocabularyKind, AdminPermission>;

export function VocabularyAdmin({ kind }: { kind: VocabularyKind }) {
  return (
    <AdminSettingsBoundary>
      {(settings) => <VocabularyAdminContent kind={kind} settings={settings} />}
    </AdminSettingsBoundary>
  );
}

function VocabularyAdminContent({ kind, settings }: {
  kind: VocabularyKind;
  settings: AdminSettings;
}) {
  const copy = COPY[kind];
  const isAuthor = kind === "authors";
  const queryKey = QUERY_KEYS[kind];
  const permissions = useAdminPermissions();
  const canDelete = permissions.includes(DELETE_PERMISSIONS[kind]);
  const client = useQueryClient();
  const { data, error: listError, isError: listFailed, isFetching, refetch } = useQuery<AdminEntityListResponseDto<VocabularyEntry>>({ queryKey, queryFn: ({ signal }) => api(`${adminApiBasePath}/${kind}`, { signal }) });
  // 新建/删除词条会改动公共画廊的筛选词表（gallery-facets，staleTime:Infinity 不会自动刷新），
  // 删除还会清除关联图片上的该属性，故一并失效后台图片列表，与 ImageAdmin.refresh 的失效集对齐。
  const refresh = () => invalidateImageData(client);
  const acceptAuthorItem = async (item: AuthorDto) => {
    client.setQueryData<AdminEntityListResponseDto<VocabularyEntry>>(queryKey, (current) => {
      if (!current) return current;
      const existingIndex = current.items.findIndex(
        (candidate) => candidate.slug === item.slug
      );
      const items = [...current.items];
      if (existingIndex >= 0) items[existingIndex] = item;
      else items.push(item);
      return { ...current, items };
    });
    await invalidateDataAfterAuthorProfileSave(client);
  };
  const [slug, setSlug] = useState("");
  const [display, setDisplay] = useState("");

  const [link, setLink] = useState("");
  const feedbackTarget = useActionFeedbackTarget(`${kind}-admin`);
  const [mutation, setMutation] = useState<VocabularyMutation>("");
  const [createError, setCreateError] = useState("");
  const createAction = useAsyncActionStatus({ resultDurationMs: null });
  const [confirmDelete, setConfirmDelete] = useState<VocabularyEntry | null>(null);
  const [page, setPage] = useState(1);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (canDelete) return;
    setConfirmDelete(null);
  }, [canDelete]);

  const slugInvalid = slug.length > 0 && !slugPattern.test(slug);
  const slugError = slugInvalid ? slugFormatHint : createError;
  const externalBusy = Boolean(mutation) || createAction.pending;
  const pageSize = settings.admin.image_page_size;
  const isFixedVocabularyEntry = (item: VocabularyEntry) => (
    kind === "themes" && item.slug === "none"
  );
  // 主题页按配置决定是否展示钉住的「未设置 / none」占位卡片；其它类别无此卡片。
  // 只过滤展示用列表，order（含 none）保持完整，拖拽排序逻辑不受影响。
  const showUnsetCard = settings.admin.show_unset_theme_card;
  const reorder = usePersistedReorder<VocabularyEntry>({
    items: data?.items,
    externalBusy,
    getKey: (item) => item.slug,
    isFixed: isFixedVocabularyEntry,
    itemLabel: (items, movedSlug) => {
      const item = items.find((candidate) => candidate.slug === movedSlug);
      return `${copy.noun}“${item?.display_name || movedSlug}”`;
    },
    save: (slugs) => api(`${adminApiBasePath}/${kind}/reorder`, {
      method: "POST",
      body: JSON.stringify({ slugs })
    }),
    refresh,
    readAuthoritative: () => {
      const queryState = client.getQueryState(queryKey);
      const cached = client.getQueryData<AdminEntityListResponseDto<VocabularyEntry>>(queryKey);
      return cached
        && queryState?.status === "success"
        && !queryState.isInvalidated
        ? cached.items
        : null;
    },
    reportError: (stage, error) => reportAdminUiError(
      `vocabulary_admin.${kind}.reorder${stage === "refresh" ? "_refresh" : ""}`,
      error
    ),
    focus: {
      itemKeys: (items) => (
        kind === "themes" && !showUnsetCard
          ? items.filter((item) => item.slug !== "none")
          : items
      ).map((item) => item.slug),
      page,
      pageSize,
      onPageChange: setPage
    }
  });
  const { order } = reorder;
  const operationBusy = reorder.busy;
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
    reorder.clearFeedback();
    await createAction.run(async () => {
      try {
        const body = isAuthor
          ? { slug: value, display_name: display.trim(), link: link.trim() }
          : { slug: value, display_name: display.trim() };
        const response = await api<AuthorMutationResponseDto | { ok: true }>(
          `${adminApiBasePath}/${kind}`,
          {
            method: "POST",
            body: JSON.stringify(body)
          }
        );
        setSlug("");
        setDisplay("");
        setLink("");
        if (isAuthor && "item" in response) {
          await acceptAuthorItem(response.item);
        } else {
          await refresh();
        }
        return true;
      } catch (error) {
        reportAdminUiError(`vocabulary_admin.${kind}.create`, error);
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
      reportAdminUiError(`vocabulary_admin.${kind}.delete`, err);
      return false;
    } finally {
      setMutation("");
    }
  };

  return (
    <section className="workspace workspace-paged">
      <WorkspaceHeader
        title={`${copy.noun}管理`}
        description={`第 ${page} / ${totalPages} 页 · 共 ${visibleItems.length} 个${copy.noun}${isFetching ? " · 加载中" : ""}`}
        feedbackTarget={feedbackTarget}
      />
      <p
        className="reorder-live-region"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {reorder.announcement}
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
            placeholder="作者主页链接（HTTPS，可选）"
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
      {reorder.feedback && (
        <ActionFeedbackOutlet
          feedback={reorder.feedback}
          target={feedbackTarget}
          announce={false}
          onClose={reorder.clearFeedback}
        />
      )}
      <div className="admin-scroll-region" ref={listRef}>
        <div className="entity-admin-grid entity-vocabulary-grid">
          {pageItems.map((item) => {
            const position = reorder.positionFor(item.slug);
            return (
              <VocabularyAdminCard
                key={item.slug}
                kind={kind}
                item={item}
                pinned={isFixedVocabularyEntry(item)}
                canDelete={canDelete}
                reorderBusy={operationBusy}
                canMovePrevious={Boolean(position && position.position > 1)}
                canMoveNext={Boolean(
                  position && position.position < position.total
                )}
                onMove={(direction) => reorder.moveByKeyboard(item.slug, direction)}
                onReorderControlRef={(direction, node) => {
                  reorder.registerReorderControl(item.slug, direction, node);
                }}
                onChanged={async (item) => {
                  if (item) await acceptAuthorItem(item);
                  else await refresh();
                }}
                onDelete={() => setConfirmDelete(item)}
                onError={(error) => reportAdminUiError(`vocabulary_admin.${kind}.update`, error)}
                onDragStart={reorder.beginDrag}
                onDragEnter={reorder.moveOver}
                onDragEnd={reorder.finishDrag}
              />
            );
          })}
          {listFailed && <QueryErrorState error={listError} onRetry={() => void refetch()} reportContext={`vocabulary_admin.${kind}.load`} />}
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
