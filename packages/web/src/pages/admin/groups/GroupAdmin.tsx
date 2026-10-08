import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adminApiBasePath, adminPermissions, slugPattern, slugMaxLength,
  type AdminSettings, type ImageGroupDto, type ImageGroupListResponseDto
} from "@imageshow/shared/browser";
import { api, isApiClientError } from "../../../lib/api/client.js";
import { imageGroupsQuery } from "../../../lib/api/groups.js";
import { queryKeys } from "../../../lib/api/query-keys.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import { ViewModeToggle } from "../../../components/actions/ViewModeToggle.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import { WorkspaceHeader } from "../../../components/layout/WorkspaceHeader.js";
import { WorkspaceToolbar } from "../../../components/layout/WorkspaceToolbar.js";
import { WorkspaceToolbarScrollbar } from "../../../components/layout/WorkspaceToolbarScrollbar.js";
import { AdminPagination } from "../../../components/navigation/AdminPagination.js";
import { AdminSettingsBoundary } from "../../../components/feedback/AdminSettingsBoundary.js";
import { QueryErrorState } from "../../../components/feedback/QueryErrorState.js";
import { useActionFeedbackTarget } from "../../../components/feedback/ActionFeedbackRegion.js";
import { ConfirmDialog } from "../../../components/dialog/ConfirmDialog.js";
import { EntityCreateForm, useEntityCreateDraft } from "../../../components/form/EntityCreateForm.js";
import { slugFormatHint } from "../../../components/form/slug-format.js";
import { useAdminPreference } from "../../../hooks/useAdminPreferences.js";
import { useAdminPermissions } from "../../../hooks/useAuthSession.js";
import { useClientPagination } from "../../../hooks/useClientPagination.js";
import { useSortOrderSave } from "../../../hooks/useSortOrderSave.js";
import { useAsyncActionStatus } from "../../../hooks/useAsyncActionStatus.js";
import { useViewModeScrollAnchor } from "../../../hooks/useViewModeScrollAnchor.js";
import { useWorkspaceToolbarCollapse } from "../../../hooks/useWorkspaceToolbarCollapse.js";
import { GroupAdminItem } from "./GroupAdminItem.js";
import "../../../styles/admin/entity.css";
import "../../../styles/admin/vocabulary.css";
import "./groups.css";

const columns = { slug: "标识", display: "显示名", count: "图片数", sort: "排序", actions: "操作" };

export function GroupAdmin() {
  return <AdminSettingsBoundary>{(settings) => <GroupAdminContent settings={settings} />}</AdminSettingsBoundary>;
}

function GroupAdminContent({ settings }: { settings: AdminSettings }) {
  const client = useQueryClient();
  const permissions = useAdminPermissions();
  const canDelete = permissions.includes(adminPermissions.groupDelete);
  const [viewMode, setViewMode] = useAdminPreference("group_view_mode");
  const query = useQuery(imageGroupsQuery);
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.groups, exact: true }, { throwOnError: true });
  const draft = useEntityCreateDraft();
  const [createError, setCreateError] = useState("");
  const createAction = useAsyncActionStatus({ resultDurationMs: null });
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ImageGroupDto | null>(null);
  const feedbackTarget = useActionFeedbackTarget("group-admin");
  const toolbarRef = useWorkspaceToolbarCollapse();
  const listRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const captureScrollAnchor = useViewModeScrollAnchor(listRef, "[data-group-slug]", viewMode);
  const externalBusy = deleting || createAction.pending;
  const sorting = useSortOrderSave({
    basePath: `${adminApiBasePath}/groups`, externalBusy, refresh,
    readValue: (slug) => client.getQueryData<ImageGroupListResponseDto>(queryKeys.groups)?.items.find((item) => item.slug === slug)?.sort_order,
    reportError: (stage, error) => reportAdminUiError(`group_admin.sort_order.${stage}`, error)
  });
  const items = query.data?.items ?? [];
  const { page, setPage, totalPages, pageItems } = useClientPagination(items, settings.admin.image_page_size);
  const slugInvalid = draft.slug.length > 0 && (!slugPattern.test(draft.slug) || draft.slug.length > slugMaxLength);
  const slugError = slugInvalid ? slugFormatHint : createError;
  useEffect(() => { if (!canDelete) setConfirmDelete(null); }, [canDelete]);
  const changeView = (next: "card" | "list") => {
    captureScrollAnchor();
    setViewMode(next);
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const value = draft.slug.trim().toLowerCase();
    if (!value || slugInvalid || draft.sortOrderInvalid || sorting.busy) return;
    setCreateError("");
    await createAction.run(async () => {
      try {
        await api(`${adminApiBasePath}/groups`, {
          method: "POST", body: JSON.stringify({ slug: value, display_name: draft.display.trim(), sort_order: draft.sortOrderValue })
        });
        client.removeQueries({ queryKey: [...queryKeys.groupImages, value] });
        draft.reset();
        setPage(1);
        await refresh();
        return true;
      } catch (error) {
        reportAdminUiError("group_admin.create", error);
        setCreateError(isApiClientError(error) && error.status === 409 ? "该分组已存在" : "分组创建或列表刷新失败，请核对后重试");
        return false;
      }
    });
  };
  const remove = async () => {
    if (!canDelete || !confirmDelete) return false;
    setDeleting(true);
    try {
      await api(`${adminApiBasePath}/groups/${confirmDelete.slug}/delete`, { method: "POST" });
      client.removeQueries({ queryKey: [...queryKeys.groupImages, confirmDelete.slug] });
      await refresh();
      return true;
    } catch (error) {
      reportAdminUiError("group_admin.delete", error);
      return false;
    } finally { setDeleting(false); }
  };
  return (
    <section ref={toolbarRef} className="workspace workspace-paged workspace-contained workspace-has-toolbar vocabulary-page group-admin-page">
      <div className="vocabulary-toolbar">
        <WorkspaceHeader title="分组管理"
          description={`共 ${items.length} 个分组${query.isPending ? " · 加载中" : ""}`}
          feedbackTarget={feedbackTarget}
          titleAccessory={<ViewModeToggle noun="分组" value={viewMode} onChange={changeView} />} />
        <WorkspaceToolbar className="vocabulary-create-toolbar">
          <EntityCreateForm
            draft={draft}
            noun="分组"
            slugPlaceholder="分组标识"
            slugError={slugError}
            slugInvalid={slugInvalid}
            disabled={externalBusy}
            submitBlocked={sorting.busy}
            pending={createAction.pending}
            feedbackTarget={feedbackTarget}
            onSlugChange={() => setCreateError("")}
            onSubmit={create}
          />
        </WorkspaceToolbar>
      </div>
      <div className="vocabulary-content">
        <div className="vocabulary-collection" data-view={viewMode} role={viewMode === "list" ? "table" : "list"} aria-label="分组列表">
          <div className="vocabulary-header" role="rowgroup" hidden={viewMode !== "list"}>
            <div className="vocabulary-header-row" role="row">
              {Object.entries(columns).map(([key, label]) => <div key={key} className={`vocabulary-column-${key}`} role="columnheader">{label}</div>)}
            </div>
          </div>
          <div className="admin-scroll-region vocabulary-scroll" ref={listRef} data-workspace-content="">
            <div ref={contentRef} className="vocabulary-items" role={viewMode === "list" ? "rowgroup" : undefined}>
              {pageItems.map((item) => <GroupAdminItem key={item.slug} item={item} viewMode={viewMode}
                canDelete={canDelete} busy={externalBusy || sorting.isSaving(item.slug)} feedbackTarget={feedbackTarget}
                onSortSave={(value) => sorting.save(item.slug, value)} onChanged={refresh} onDelete={() => setConfirmDelete(item)} />)}
            </div>
            {query.isError && <QueryErrorState error={query.error} onRetry={() => void query.refetch()} reportContext="group_admin.load" />}
            {!query.isError && !query.isPending && !items.length && <p className="muted vocabulary-empty">还没有分组</p>}
          </div>
        </div>
      </div>
      <OverlayScrollbar targetRef={listRef} contentRef={contentRef} pageEdge />
      <AdminPagination ariaLabel="分组分页" page={page} totalPages={totalPages} onPageChange={setPage} />
      {canDelete && confirmDelete && <ConfirmDialog title="删除分组"
        description={`删除分组「${confirmDelete.display_name || confirmDelete.slug}」会使指向它的外部随机链接失效，图片仍保留在图库中。此操作无法撤销。`}
        confirmLabel="确认删除" requireFinalConfirmation finalConfirmationLabel="再次确认"
        pendingIcon="delete-bin-5-line" busy={deleting} onClose={() => setConfirmDelete(null)} onConfirm={remove} />}
      <WorkspaceToolbarScrollbar />
    </section>
  );
}
