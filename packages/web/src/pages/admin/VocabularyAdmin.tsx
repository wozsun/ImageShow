import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  adminPermissions,
  isNamedSlug,
  unsetSelector,
  type AuthorDto,
  type AuthorMutationResponseDto,
  type AdminEntityListResponseDto,
  type AdminSettings,
  type AdminPermission,
  adminApiBasePath,
  slugPattern,
  type TagDto,
  type ThemeDto
} from "@imageshow/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { tableFeatures, useTable, type ColumnDef } from "@tanstack/react-table";
import { api, isApiClientError } from "../../lib/api/client.js";
import { AdminIcon } from "../../components/icon/AdminIcon.js";
import { StableButtonLabel } from "../../components/data-display/StableButtonLabel.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { useActionFeedbackTarget } from "../../components/feedback/ActionFeedbackRegion.js";
import { useWorkspaceToolbarCollapse } from "../../hooks/useWorkspaceToolbarCollapse.js";
import { WorkspaceToolbarScrollbar } from "../../components/layout/WorkspaceToolbarScrollbar.js";
import { WorkspaceToolbar } from "../../components/layout/WorkspaceToolbar.js";
import { workspaceScrollContainer } from "../../lib/ui/workspace-scroll.js";
import { AdminPagination } from "../../components/navigation/AdminPagination.js";
import { ConfirmDialog } from "../../components/dialog/ConfirmDialog.js";
import { WorkspaceHeader } from "../../components/layout/WorkspaceHeader.js";
import {
  VocabularyAdminItem,
  vocabularyColumnLabels,
  type VocabularyColumnId
} from "./VocabularyAdminItem.js";
import { slugFormatHint } from "../../components/form/slug-format.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import { AdminSettingsBoundary } from "../../components/feedback/AdminSettingsBoundary.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import {
  invalidateVocabularyData,
  invalidateDataAfterSortOrderSave,
  invalidateImageData
} from "../../lib/api/query-invalidation.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";
import { useAdminPermissions } from "../../hooks/useAuthSession.js";
import { useAdminPreference } from "../../hooks/useAdminPreferences.js";
import { useSortOrderSave } from "../../hooks/useSortOrderSave.js";
import { FieldError } from "../../components/form/FieldError.js";
import "../../styles/admin/entity.css";
import "../../styles/admin/vocabulary.css";

type VocabularyKind = "tags" | "themes" | "authors";
type VocabularyEntry = TagDto | ThemeDto | AuthorDto;
type VocabularyMutation = "" | "delete";

const vocabularyFeatures = tableFeatures({});
const vocabularyColumns: ColumnDef<typeof vocabularyFeatures, VocabularyEntry>[] =
  Object.entries(vocabularyColumnLabels).map(([id, header]) => ({ id, header }));
const termColumns = vocabularyColumns.filter((column) => column.id !== "link");
const emptyVocabulary: VocabularyEntry[] = [];
const vocabularyRowId = (item: VocabularyEntry) => item.slug;
const VIEW_PREFERENCES = {
  themes: "theme_view_mode",
  tags: "tag_view_mode",
  authors: "author_view_mode"
} as const;

const COPY = {
  tags: {
    noun: "标签",
    slugPlaceholder: "标签 slug",
    displayPlaceholder: "显示名（可选）",
    empty: "还没有标签",
    deleteDescription: (item: VocabularyEntry) =>
      `删除标签「${item.display_name || item.slug}」，会从 ${item.image_count} 张关联图片（包含回收站）上移除该标签，此操作无法撤销。`
  },
  themes: {
    noun: "主题",
    slugPlaceholder: "主题 slug",
    displayPlaceholder: "显示名（可选）",
    empty: "还没有主题（上传图片或在上方新建）",
    deleteDescription: (item: VocabularyEntry) =>
      `删除主题「${item.display_name || item.slug}」，其 ${item.image_count} 张关联图片（包含回收站）将归为「未设置」，此操作无法撤销。`
  },
  authors: {
    noun: "作者",
    slugPlaceholder: "作者 slug",
    displayPlaceholder: "显示名（可选）",
    empty: "还没有作者（上传图片或在上方新建）",
    deleteDescription: (item: VocabularyEntry) =>
      `删除作者「${item.display_name || item.slug}」，其 ${item.image_count} 张关联图片（包含回收站）的作者属性将被清除，此操作无法撤销。`
  }
} as const;

const QUERY_KEYS = {
  tags: queryKeys.tags,
  themes: queryKeys.themes,
  authors: queryKeys.authors
} as const;
const DELETE_PERMISSIONS = {
  tags: adminPermissions.tagDelete,
  themes: adminPermissions.themeDelete,
  authors: adminPermissions.authorDelete
} satisfies Record<VocabularyKind, AdminPermission>;

export function VocabularyAdmin({ kind }: { kind: VocabularyKind }) {
  return (
    <AdminSettingsBoundary>
      {(settings) => <VocabularyAdminContent key={kind} kind={kind} settings={settings} />}
    </AdminSettingsBoundary>
  );
}

function VocabularyAdminContent({
  kind,
  settings
}: {
  kind: VocabularyKind;
  settings: AdminSettings;
}) {
  const copy = COPY[kind];
  const isAuthor = kind === "authors";
  const [viewMode, setViewMode] = useAdminPreference(VIEW_PREFERENCES[kind]);
  const queryKey = QUERY_KEYS[kind];
  const permissions = useAdminPermissions();
  const canDelete = permissions.includes(DELETE_PERMISSIONS[kind]);
  const client = useQueryClient();
  const {
    data,
    error: listError,
    isError: listFailed,
    isPending,
    refetch
  } = useQuery<AdminEntityListResponseDto<VocabularyEntry>>({
    queryKey,
    queryFn: ({ signal }) => api(`${adminApiBasePath}/${kind}`, { signal })
  });
  // Vocabulary edits change labels and choices; deleting a term also changes
  // image membership and therefore uses the full image invalidation below.
  const refreshVocabulary = () => invalidateVocabularyData(client, queryKey);
  const acceptAuthorItem = async (item: AuthorDto) => {
    const listState = client.getQueryState(queryKey);
    const current = client.getQueryData<AdminEntityListResponseDto<VocabularyEntry>>(queryKey);
    const previous = current?.items.find((entry) => entry.slug === item.slug);
    const orderKnown = previous
      ? previous.sort_order === item.sort_order
      : current?.items.every((entry) => item.sort_order > entry.sort_order);
    if (listState?.fetchStatus !== "idle" || !orderKnown) {
      // The list owner preserves database collation and includes overlapping edits.
      await refreshVocabulary();
      return;
    }
    await client.cancelQueries({ queryKey, exact: true });
    client.setQueryData<AdminEntityListResponseDto<VocabularyEntry>>(queryKey, (current) => {
      if (!current) return current;
      const existingIndex = current.items.findIndex((candidate) => candidate.slug === item.slug);
      const items = [...current.items];
      if (existingIndex >= 0) items[existingIndex] = item;
      else items.unshift(item);
      return { ...current, items };
    });
    await invalidateVocabularyData(client);
  };
  const [slug, setSlug] = useState("");
  const [display, setDisplay] = useState("");

  const [link, setLink] = useState("");
  const [mutation, setMutation] = useState<VocabularyMutation>("");
  const feedbackTarget = useActionFeedbackTarget(`${kind}-admin`);
  const workspaceToolbarRef = useWorkspaceToolbarCollapse();
  const [createError, setCreateError] = useState("");
  const createAction = useAsyncActionStatus({ resultDurationMs: null });
  const [confirmDelete, setConfirmDelete] = useState<VocabularyEntry | null>(null);
  const [page, setPage] = useState(1);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listContentRef = useRef<HTMLDivElement | null>(null);
  const scrollAnchorRef = useRef<{
    element: HTMLElement;
    offset: number;
  } | null>(null);

  const changeView = (nextView: "list" | "card") => {
    if (nextView === viewMode) return;
    const viewport = workspaceScrollContainer(listRef.current);
    if (viewport && viewport.scrollTop > 0) {
      const viewportTop = viewport.getBoundingClientRect().top;
      const anchor = Array.from(viewport.querySelectorAll<HTMLElement>("[data-vocabulary-slug]"))
        .find((element) => element.getBoundingClientRect().bottom > viewportTop);
      scrollAnchorRef.current = anchor ? {
        element: anchor,
        offset: anchor.getBoundingClientRect().top - viewportTop
      } : null;
    }
    setViewMode(nextView);
  };

  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    scrollAnchorRef.current = null;
    const viewport = workspaceScrollContainer(listRef.current);
    if (!viewport || !anchor?.element.isConnected) return;
    const viewportTop = viewport.getBoundingClientRect().top;
    const delta = anchor.element.getBoundingClientRect().top - viewportTop - anchor.offset;
    viewport.scrollTop += delta;
  }, [viewMode]);

  useEffect(() => {
    if (canDelete) return;
    setConfirmDelete(null);
  }, [canDelete]);

  // Themes and authors reserve the unset selector; tags accept any slug.
  const reservesUnset = kind !== "tags";
  const slugValid = reservesUnset ? isNamedSlug(slug) : slugPattern.test(slug);
  const slugInvalid = slug.length > 0 && !slugValid;
  const slugError = !slugInvalid
    ? createError
    : reservesUnset && slug === unsetSelector
      ? `null 是未设置${copy.noun}的保留值，不能用作${copy.noun}标识`
      : slugFormatHint;
  const externalBusy = Boolean(mutation) || createAction.pending;
  const pageSize = settings.admin.image_page_size;
  const sorting = useSortOrderSave({
    basePath: `${adminApiBasePath}/${kind}`,
    externalBusy,
    refresh: () => invalidateDataAfterSortOrderSave(client, queryKey),
    readValue: (slug) =>
      client
        .getQueryData<AdminEntityListResponseDto<VocabularyEntry>>(queryKey)
        ?.items.find((item) => item.slug === slug)?.sort_order,
    reportError: (stage, error) =>
      reportAdminUiError(
        `vocabulary_admin.${kind}.sort_order.${stage}`,
        error
      )
  });
  const order = data?.items ?? emptyVocabulary;
  const operationBusy = sorting.busy;
  const totalPages = Math.max(1, Math.ceil(order.length / pageSize));
  const pageItems = useMemo(
    () => order.slice((page - 1) * pageSize, page * pageSize),
    [order, page, pageSize]
  );
  const table = useTable({
    features: vocabularyFeatures,
    columns: isAuthor ? vocabularyColumns : termColumns,
    data: pageItems,
    getRowId: vocabularyRowId
  });
  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const value = slug.trim().toLowerCase();
    if (!value || operationBusy || slugInvalid) return;
    if (order.some((item) => item.slug === value)) {
      setCreateError(`该${copy.noun}已存在`);
      return;
    }

    setCreateError("");
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
          await refreshVocabulary();
        }
        setPage(1);
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
      await invalidateImageData(client);
      return true;
    } catch (err) {
      reportAdminUiError(`vocabulary_admin.${kind}.delete`, err);
      return false;
    } finally {
      setMutation("");
    }
  };

  return (
    <section
      ref={workspaceToolbarRef}
      className="workspace workspace-paged workspace-contained workspace-has-toolbar vocabulary-page"
    >
      <div className="vocabulary-toolbar" data-kind={kind}>
        <WorkspaceHeader
          title={`${copy.noun}管理`}
          description={`第 ${page} / ${totalPages} 页 · 共 ${order.length} 个${copy.noun}${isPending ? " · 加载中" : ""}`}
          feedbackTarget={feedbackTarget}
          titleAccessory={
            <button
              type="button"
              className="state-toggle-button vocabulary-view-switch"
              data-shifted={viewMode === "list"}
              aria-pressed={viewMode === "list"}
              aria-label={`${copy.noun}以${viewMode === "card" ? "卡片" : "列表"}显示；点击切换为${viewMode === "card" ? "列表" : "卡片"}`}
              title={`切换为${viewMode === "card" ? "列表" : "卡片"}`}
              onClick={() => changeView(viewMode === "card" ? "list" : "card")}
            >
              <span className="state-toggle-label">{viewMode === "card" ? "卡片" : "列表"}</span>
              <span className="state-toggle-thumb" aria-hidden="true" />
            </button>
          }
        />
        <WorkspaceToolbar className="vocabulary-create-toolbar">
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
                disabled={externalBusy}
                maxLength={32}
                aria-invalid={Boolean(slugError)}
              />
              <FieldError message={slugError} announce />
            </div>
            <input
              className="vocabulary-create-display"
              value={display}
              onChange={(event) => setDisplay(event.target.value)}
              placeholder={copy.displayPlaceholder}
              disabled={externalBusy}
              maxLength={64}
            />
            {isAuthor && (
              <input
                className="vocabulary-create-link"
                value={link}
                onChange={(event) => setLink(event.target.value)}
                placeholder="作者主页链接（HTTPS，可选）"
                disabled={externalBusy}
                maxLength={2048}
              />
            )}
            <button
              className="button vocabulary-create-button"
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
        </WorkspaceToolbar>
      </div>
      <div className="vocabulary-content">
        <div
          className="vocabulary-collection"
          data-view={viewMode}
          data-kind={kind}
          role={viewMode === "list" ? "table" : "list"}
          aria-label={`${copy.noun}${viewMode === "list" ? "列表" : "卡片"}`}
        >
          <div className="vocabulary-header" role="rowgroup" hidden={viewMode !== "list"}>
            {table.getHeaderGroups().map((group) => (
              <div className="vocabulary-header-row" role="row" key={group.id}>
                {group.headers.map((header) => (
                  <div
                    className={`vocabulary-column-${header.column.id}`}
                    role="columnheader"
                    key={header.id}
                    title={header.column.id === "count" ? "全部关联图片（包含回收站）" : undefined}
                  >
                    <table.FlexRender header={header} />
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div
            className="admin-scroll-region vocabulary-scroll"
            ref={listRef}
            data-workspace-content=""
          >
            <div ref={listContentRef} className="vocabulary-items" role={viewMode === "list" ? "rowgroup" : undefined}>
              {table.getRowModel().rows.map((row) => {
                const item = row.original;
                return (
                  <VocabularyAdminItem
                    key={`${kind}:${row.id}`}
                    kind={kind}
                    item={item}
                    columns={row.getAllCells().map((cell) => cell.column.id as VocabularyColumnId)}
                    viewMode={viewMode}
                    canDelete={canDelete}
                    sortBusy={externalBusy || sorting.isSaving(item.slug)}
                    sortFeedbackTarget={feedbackTarget}
                    onSortSave={(value) => sorting.save(item.slug, value)}
                    onChanged={async (item) => {
                      if (item) await acceptAuthorItem(item);
                      else await refreshVocabulary();
                    }}
                    onDelete={() => setConfirmDelete(item)}
                    onError={(error) => reportAdminUiError(`vocabulary_admin.${kind}.update`, error)}
                  />
                );
              })}
            </div>
            {listFailed && (
              <QueryErrorState
                error={listError}
                onRetry={() => void refetch()}
                reportContext={`vocabulary_admin.${kind}.load`}
              />
            )}
            {!listFailed && !order.length && !isPending && <p className="muted vocabulary-empty">{copy.empty}</p>}
          </div>
        </div>
      </div>
      <OverlayScrollbar targetRef={listRef} contentRef={listContentRef} pageEdge />
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
          pendingIcon="delete-bin-5-line"
          busy={mutation === "delete"}
          onClose={() => setConfirmDelete(null)}
          onConfirm={remove}
        />
      )}
      <WorkspaceToolbarScrollbar />
    </section>
  );
}
