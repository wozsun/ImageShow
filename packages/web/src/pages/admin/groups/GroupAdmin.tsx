import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adminApiBasePath, adminPermissions, slugPattern, slugMaxLength,
  isSortOrder, sortOrderMin, sortOrderMax,
  type AdminSettings, type ImageGroupDto, type ImageGroupListResponseDto
} from "@imageshow/shared/browser";
import { api, isApiClientError } from "../../../lib/api/client.js";
import { imageGroupsQuery } from "../../../lib/api/groups.js";
import { queryKeys } from "../../../lib/api/query-keys.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import { workspaceScrollContainer } from "../../../lib/ui/workspace-scroll.js";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { StableButtonLabel } from "../../../components/data-display/StableButtonLabel.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import { WorkspaceHeader } from "../../../components/layout/WorkspaceHeader.js";
import { WorkspaceToolbar } from "../../../components/layout/WorkspaceToolbar.js";
import { WorkspaceToolbarScrollbar } from "../../../components/layout/WorkspaceToolbarScrollbar.js";
import { AdminPagination } from "../../../components/navigation/AdminPagination.js";
import { AdminSettingsBoundary } from "../../../components/feedback/AdminSettingsBoundary.js";
import { QueryErrorState } from "../../../components/feedback/QueryErrorState.js";
import { useActionFeedbackTarget } from "../../../components/feedback/ActionFeedbackRegion.js";
import { ConfirmDialog } from "../../../components/dialog/ConfirmDialog.js";
import { FieldError } from "../../../components/form/FieldError.js";
import { slugFormatHint } from "../../../components/form/slug-format.js";
import { useAdminPreference } from "../../../hooks/useAdminPreferences.js";
import { useAdminPermissions } from "../../../hooks/useAuthSession.js";
import { useSortOrderSave } from "../../../hooks/useSortOrderSave.js";
import { useAsyncActionStatus } from "../../../hooks/useAsyncActionStatus.js";
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
  const [slug, setSlug] = useState("");
  const [display, setDisplay] = useState("");
  const [sortOrder, setSortOrder] = useState("");
  const sortOrderInvalid = sortOrder !== "" && !isSortOrder(Number(sortOrder));
  const [createError, setCreateError] = useState("");
  const createAction = useAsyncActionStatus({ resultDurationMs: null });
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ImageGroupDto | null>(null);
  const [page, setPage] = useState(1);
  const feedbackTarget = useActionFeedbackTarget("group-admin");
  const toolbarRef = useWorkspaceToolbarCollapse();
  const listRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<{ element: HTMLElement; offset: number } | null>(null);
  const externalBusy = deleting || createAction.pending;
  const sorting = useSortOrderSave({
    basePath: `${adminApiBasePath}/groups`, externalBusy, refresh,
    readValue: (slug) => client.getQueryData<ImageGroupListResponseDto>(queryKeys.groups)?.items.find((item) => item.slug === slug)?.sort_order,
    reportError: (stage, error) => reportAdminUiError(`group_admin.sort_order.${stage}`, error)
  });
  const items = query.data?.items ?? [];
  const pageSize = settings.admin.image_page_size;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const pageItems = items.slice((page - 1) * pageSize, page * pageSize);
  const slugInvalid = slug.length > 0 && (!slugPattern.test(slug) || slug.length > slugMaxLength);
  const slugError = slugInvalid ? slugFormatHint : createError;
  useEffect(() => { setPage((current) => Math.min(current, totalPages)); }, [totalPages]);
  useEffect(() => { if (!canDelete) setConfirmDelete(null); }, [canDelete]);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    const viewport = workspaceScrollContainer(listRef.current);
    if (!viewport || !anchor?.element.isConnected) return;
    viewport.scrollTop += anchor.element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset;
  }, [viewMode]);
  const changeView = () => {
    const viewport = workspaceScrollContainer(listRef.current);
    if (viewport && viewport.scrollTop > 0) {
      const top = viewport.getBoundingClientRect().top;
      const element = Array.from(viewport.querySelectorAll<HTMLElement>("[data-group-slug]"))
        .find((element) => element.getBoundingClientRect().bottom > top);
      anchorRef.current = element ? { element, offset: element.getBoundingClientRect().top - top } : null;
    }
    setViewMode(viewMode === "card" ? "list" : "card");
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const value = slug.trim().toLowerCase();
    if (!value || slugInvalid || sortOrderInvalid || sorting.busy) return;
    setCreateError("");
    await createAction.run(async () => {
      try {
        await api(`${adminApiBasePath}/groups`, {
          method: "POST", body: JSON.stringify({ slug: value, display_name: display.trim(), sort_order: sortOrder === "" ? undefined : Number(sortOrder) })
        });
        client.removeQueries({ queryKey: [...queryKeys.groupImages, value] });
        setSlug("");
        setDisplay("");
        setSortOrder("");
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
          titleAccessory={
            <button type="button" className="state-toggle-button vocabulary-view-switch"
              data-shifted={viewMode === "list"} aria-pressed={viewMode === "list"}
              aria-label={`分组以${viewMode === "card" ? "卡片" : "列表"}显示；点击切换为${viewMode === "card" ? "列表" : "卡片"}`}
              onClick={changeView}>
              <span className="state-toggle-label">{viewMode === "card" ? "卡片" : "列表"}</span>
              <span className="state-toggle-thumb" aria-hidden="true" />
            </button>
          } />
        <WorkspaceToolbar className="vocabulary-create-toolbar">
          <form className="admin-create-form" onSubmit={create}>
            <div className="admin-create-field entity-slug-field">
              <input className="entity-create-slug" value={slug} placeholder="分组标识" aria-label="分组标识"
                maxLength={slugMaxLength} disabled={externalBusy} aria-invalid={Boolean(slugError)}
                onChange={(event) => { setSlug(event.target.value.toLowerCase()); setCreateError(""); }} />
              <FieldError message={slugError} announce />
            </div>
            <input className="vocabulary-create-display" value={display} placeholder="显示名（可选）" aria-label="分组显示名"
              maxLength={64} disabled={externalBusy} onChange={(event) => setDisplay(event.target.value)} />
            <input className="vocabulary-create-sort" type="number" step={1}
              min={sortOrderMin} max={sortOrderMax} value={sortOrder}
              placeholder="排序（可选）" aria-label="分组排序（可选）" aria-invalid={sortOrderInvalid}
              disabled={externalBusy} onChange={(event) => setSortOrder(event.target.value)} />
            <button className="button vocabulary-create-button" type="submit" disabled={sorting.busy || !slug.trim() || slugInvalid || sortOrderInvalid}>
              <AdminIcon name="add-line" />
              <StableButtonLabel idle="新建分组" busyText="新建中" busy={createAction.pending} />
            </button>
          </form>
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
