import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adminBasePath,
  type EditableImageSnapshotDto, type AdminImageListItemDto, type AdminImageSort, type AdminSettings
} from "@imageshow/shared/browser";
import { AdminSettingsBoundary } from "../../../components/feedback/AdminSettingsBoundary.js";
import {
  ActionFeedbackOutlet, ActionFeedbackRegion, useActionFeedbackTarget
} from "../../../components/feedback/ActionFeedbackRegion.js";
import { QueryErrorState } from "../../../components/feedback/QueryErrorState.js";
import { TwoStepConfirmButton } from "../../../components/actions/TwoStepConfirmButton.js";
import { useAsyncActionStatus } from "../../../hooks/useAsyncActionStatus.js";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import { WorkspaceToolbar } from "../../../components/layout/WorkspaceToolbar.js";
import { WorkspaceToolbarScrollbar } from "../../../components/layout/WorkspaceToolbarScrollbar.js";
import { AdminPagination } from "../../../components/navigation/AdminPagination.js";
import { useAdminImageDetailCapability } from "../../../components/image/useAdminImageDetailCapability.js";
import { useImageEditorCapability } from "../../../components/image/editor/useImageEditorCapability.js";
import { useAdminPreference } from "../../../hooks/useAdminPreferences.js";
import { mobileViewportMediaQuery, useMediaQuery } from "../../../hooks/useMediaQuery.js";
import { usePageScrollLock } from "../../../hooks/usePageScrollLock.js";
import { useWorkspaceToolbarCollapse } from "../../../hooks/useWorkspaceToolbarCollapse.js";
import { addImageGroupMembers, imageGroupsQuery, refreshImageGroup, removeImageGroupMembers } from "../../../lib/api/groups.js";
import { isApiClientError } from "../../../lib/api/client.js";
import { queryKeys } from "../../../lib/api/query-keys.js";
import { useIngestionVocabulary } from "../../../lib/api/ingestion-vocabulary.js";
import { useStorageNameResolver } from "../../../lib/api/storage-options.js";
import { createPageLifetimeModuleLoader } from "../../../lib/page-lifetime-module-loader.js";
import { createActionFeedback, type ActionFeedbackState } from "../../../lib/ui/action-feedback.js";
import { preloadIntentProps } from "../../../lib/ui/preload-intent.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import { displayNameOrSlug, imageDisplayTitle } from "../../../lib/ui/formatters.js";
import { workspaceScrollContainer } from "../../../lib/ui/workspace-scroll.js";
import { ImageListViewControls } from "../../../components/image/ImageListViewControls.js";
import { AdminImageCard } from "../images/AdminImageCard.js";
import { emptyImageAdminFilters, ImageAdminFilters, type ImageAdminFilterValues } from "../images/ImageAdminFilters.js";
import { useImageAdminPageNavigation } from "../images/useImageAdminPageNavigation.js";
import { useImageAdminSelection } from "../images/useImageAdminSelection.js";
import { GroupRandomLink, imageMatchesGroupLink, type GroupLinkOptions } from "./GroupRandomLink.js";
import { groupMemberResultLabels } from "./group-member-results.js";
import "../../../styles/admin/images.css";
import "../../../styles/admin/group-detail.css";

const loadIdInput = createPageLifetimeModuleLoader(() => import("../images/ImageIdInputDialog.js"));
type MembershipIntent = "group-add" | "group-remove";
type IdInputSession = { module: Awaited<ReturnType<typeof loadIdInput>>; intent: MembershipIntent };
const selectionHelpId = "group-image-range-selection-help";

export function GroupDetail() {
  const { slug = "" } = useParams();
  return (
    <AdminSettingsBoundary>
      {(settings) => <GroupDetailContent key={slug} slug={slug} settings={settings} />}
    </AdminSettingsBoundary>
  );
}

function GroupDetailContent({ slug, settings }: { slug: string; settings: AdminSettings }) {
  const client = useQueryClient();
  const groups = useQuery(imageGroupsQuery);
  const group = groups.data?.items.find((item) => item.slug === slug);
  const [view, setView] = useState<"members" | "picker">("members");
  const [linkOptions, setLinkOptions] = useState<GroupLinkOptions>({ device: "all", brightness: "", mode: "" });
  const [filters, setFilters] = useState<ImageAdminFilterValues>(emptyImageAdminFilters);
  const [thumbnailFit, setThumbnailFit] = useAdminPreference("image_thumbnail_fit");
  const [sortBy, setSortBy] = useAdminPreference("image_sort_by");
  const [sortOrder, setSortOrder] = useAdminPreference("image_sort_order");
  const [sort, setSort] = useState<AdminImageSort>(() => ({ sort_by: sortBy, order: sortOrder }));
  const mobileLayout = useMediaQuery(mobileViewportMediaQuery);
  const { data: vocabulary } = useIngestionVocabulary();
  const storageName = useStorageNameResolver();
  const toolbarRef = useWorkspaceToolbarCollapse();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const navigation = useImageAdminPageNavigation({
    view: "ready", filters, sort, pageSize: settings.admin.image_page_size,
    group: { slug, mode: view }, enabled: Boolean(group)
  });
  const selection = useImageAdminSelection(navigation.items);
  const feedbackTarget = useActionFeedbackTarget("group-detail");
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const [writing, setWriting] = useState(false);
  const listAction = useAsyncActionStatus({ minimumPendingMs: 0, resultDurationMs: null });
  const editor = useImageEditorCapability({
    onOpenError: (error) => {
      reportAdminUiError("group_detail.preview_load", error);
      setFeedback(createActionFeedback("图片核对窗口准备失败，请重新加载页面", "error"));
    }
  });
  const detail = useAdminImageDetailCapability<AdminImageListItemDto>((error) => {
    reportAdminUiError("group_detail.detail_load", error);
    setFeedback(createActionFeedback("图片详情加载失败，请重新加载页面", "error"));
  });
  const [idInput, setIdInput] = useState<IdInputSession | null>(null);
  const [idInputPending, setIdInputPending] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const failedOpenerRef = useRef<HTMLElement | null>(null);
  const mountedRef = useRef(false);
  const openingRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  usePageScrollLock(idInputPending);
  useLayoutEffect(() => {
    if (idInputPending) return;
    const opener = failedOpenerRef.current;
    failedOpenerRef.current = null;
    if (opener?.isConnected && !opener.closest("[inert]")) opener.focus();
  }, [idInputPending]);
  const entryBusy = writing || Boolean(editor.pending) || detail.pendingItemId !== null || !group;
  const interfaceBusy = entryBusy || idInputPending || Boolean(detail.item) || Boolean(idInput) || Boolean(editor.session);
  const clearSelection = selection.clear;
  useEffect(() => {
    clearSelection();
    workspaceScrollContainer(gridRef.current)?.scrollTo({ top: 0, left: 0 });
  }, [clearSelection, navigation.scopeKey, navigation.pageNumber]);

  const changeSort = (next: AdminImageSort) => {
    if (interfaceBusy) return;
    setSort(next);
    if (next.sort_by !== sort.sort_by) setSortBy(next.sort_by);
    if (next.order !== sort.order) setSortOrder(next.order);
    clearSelection();
    setFeedback(null);
  };

  const openIdInput = async (intent: MembershipIntent, opener: HTMLButtonElement) => {
    if (openingRef.current || entryBusy) return;
    openingRef.current = true;
    openerRef.current = opener;
    setIdInputPending(true);
    try {
      const module = await loadIdInput();
      if (mountedRef.current && opener.isConnected) setIdInput({ module, intent });
    } catch (error) {
      if (mountedRef.current) {
        failedOpenerRef.current = opener;
        reportAdminUiError("group_detail.id_input_load", error);
        setFeedback(createActionFeedback("按 ID 指定图片功能加载失败，请重新加载页面", "error"));
      }
    } finally {
      openingRef.current = false;
      if (mountedRef.current) setIdInputPending(false);
    }
  };
  const openResolvedImages = (items: EditableImageSnapshotDto[]) => {
    if (!idInput || !openerRef.current) return Promise.resolve("interrupted" as const);
    return editor.open(
      { sources: items, intent: idInput.intent, fromDialog: true },
      openerRef.current,
      () => setIdInput(null)
    );
  };
  const changeMembership = async (intent: MembershipIntent, ids: string[]) => {
    const adding = intent === "group-add";
    let confirmed = false;
    let complete = false;
    let groupMissing = false;
    let message = "";
    setWriting(true);
    setFeedback(null);
    try {
      if (adding) {
        const { items } = await addImageGroupMembers(slug, ids);
        confirmed = true;
        complete = items.every((item) => item.status === "added" || item.status === "already_member");
        message = Object.entries(groupMemberResultLabels).flatMap(([status, label]) => {
          const count = items.filter((item) => item.status === status).length;
          return count ? [`${label} ${count} 张`] : [];
        }).join("；");
        if (!complete) {
          message = items.filter((item) => item.status !== "added" && item.status !== "already_member")
            .map((item) => `${item.id}：${groupMemberResultLabels[item.status]}`).join("；");
        }
      } else {
        const { removed } = await removeImageGroupMembers(slug, ids);
        confirmed = true;
        complete = true;
        message = removed ? `已移出 ${removed} 张图片` : "这些图片已不在组内";
      }
      clearSelection();
    } catch (error) {
      reportAdminUiError("group_members.change", error);
      groupMissing = isApiClientError(error) && error.status === 404;
      message = groupMissing
        ? "分组不存在或已删除"
        : `${adding ? "加入" : "移出"}结果未确认，请关闭后核对刷新后的组内图片`;
    } finally {
      try {
        if (groupMissing) {
          await client.invalidateQueries({ queryKey: queryKeys.groups, exact: true }, { throwOnError: true });
        } else {
          await refreshImageGroup(client, slug, confirmed);
        }
      } catch (error) {
        reportAdminUiError("group_members.refresh", error);
        message += "；列表刷新失败，请关闭后重试加载";
        complete = false;
      }
      if (mountedRef.current) {
        setWriting(false);
        if (complete || groupMissing) setFeedback(createActionFeedback(message, complete ? "success" : "error"));
      }
    }
    return { complete, message };
  };
  const selectedFor = (intent: MembershipIntent) => selection.selected.filter((id) => {
    const member = view === "members" || navigation.items.find((item) => item.id === id)?.in_group;
    return intent === "group-add" ? !member : member;
  });
  const submitVisibleMembers = (intent: MembershipIntent, ids: string[]) => listAction.run(async () => {
    const result = await changeMembership(intent, ids);
    if (!result.complete && mountedRef.current) {
      setFeedback(createActionFeedback(result.message, "error"));
    }
    return result.complete;
  });
  const membershipButton = (intent: MembershipIntent, ids: string[], label: string, disabled = false, toolbar = false) => {
    if (intent === "group-remove" && ids.length) {
      return (
        <TwoStepConfirmButton
          className="danger-button is-subtle group-member-remove"
          showLabel={toolbar}
          idleIcon="subtract-line"
          confirmIcon="check-line"
          idleLabel={label}
          confirmLabel="确认移出"
          busyLabel="移出中"
          busy={writing}
          disabled={interfaceBusy || disabled}
          invalidationKey={ids.join(",")}
          onConfirm={() => void submitVisibleMembers(intent, ids)}
        />
      );
    }
    return (
      <button
        type="button"
        className={intent === "group-remove" ? "danger-button is-subtle group-member-remove" : ""}
        aria-label={label}
        title={label}
        disabled={(toolbar ? entryBusy : interfaceBusy) || disabled}
        {...(!ids.length ? preloadIntentProps(() => { void loadIdInput().catch(() => undefined); }) : {})}
        onClick={(event) => {
          if (ids.length) void submitVisibleMembers(intent, ids);
          else void openIdInput(intent, event.currentTarget);
        }}
      >
        <AdminIcon name={intent === "group-add" ? "add-line" : "subtract-line"} />
        {toolbar && label}
      </button>
    );
  };

  const cardMetadata = (item: AdminImageListItemDto) => {
    if (view === "picker") {
      return item.in_group ? <span className="admin-image-card-meta">已在组内</span> : undefined;
    }
    if (imageMatchesGroupLink(item, linkOptions)) return undefined;
    return (
      <span className="admin-image-card-meta" title="不符合当前链接的设备或亮度条件；自动设备按当前浏览器识别">
        <AdminIcon name="information-line" />条件外
      </span>
    );
  };
  const viewSwitch = (
    <div className="image-admin-view-switch">
      {(["members", "picker"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          className={view === mode ? "active" : ""}
          aria-pressed={view === mode}
          disabled={interfaceBusy}
          onClick={() => setView(mode)}
        >
          {mode === "members" ? "组内图片" : "图库"}
        </button>
      ))}
    </div>
  );

  if (groups.isSuccess && !group) {
    return (
      <section className="workspace group-detail-page">
        <header className="workspace-head">
          <h1><Link className="group-title-link" to={`${adminBasePath}/groups`}>分组管理</Link></h1>
        </header>
        <div className="group-missing-state">
          <p role="status">分组不存在或已删除</p>
          <Link className="button" to={`${adminBasePath}/groups`}>返回分组列表</Link>
        </div>
      </section>
    );
  }

  return (
    <section
      ref={toolbarRef}
      className="workspace workspace-paged workspace-has-toolbar group-detail-page"
      onClick={(event) => selection.clearFromPageClick(event, interfaceBusy)}
    >
      <header className="workspace-head image-admin-head">
        <div className="image-admin-head-copy" data-workspace-pinned="">
          <h1><Link className="group-title-link" to={`${adminBasePath}/groups`}>分组管理</Link></h1>
          {mobileLayout && viewSwitch}
          <p role="status">
            {group ? (
              <><strong>{displayNameOrSlug(group)}</strong> · 组内 {group.image_count} 张</>
            ) : groups.isPending ? "加载中" : groups.isError ? "分组读取失败" : "分组不存在"}
          </p>
          <ActionFeedbackRegion className="image-admin-feedback-region" target={feedbackTarget} />
        </div>
        <WorkspaceToolbar className="image-admin-toolbar">
          {!mobileLayout && <div className="image-admin-head-tools">{viewSwitch}</div>}
          <div className="image-list-controls">
            <ImageAdminFilters
              leadingControls={(doubleRow) => (
                <GroupRandomLink
                  slug={slug}
                  value={linkOptions}
                  onChange={(key, value) => setLinkOptions((current) => ({ ...current, [key]: value }))}
                  doubleRow={doubleRow}
                  mobileLayout={mobileLayout}
                  disabled={interfaceBusy}
                />
              )}
              value={filters}
              vocabulary={vocabulary}
              mobileLayout={mobileLayout}
              disabled={interfaceBusy}
              onChange={(key, value) => setFilters((current) => ({ ...current, [key]: value }))}
              onClear={() => setFilters({ ...emptyImageAdminFilters })}
            />
            <div className="image-list-toolbar">
              <div className="inline-actions image-list-selection">
                <span id={selectionHelpId} className="image-list-selection-help">按住 Shift 点击卡片主体，或按 Shift+Enter，可连续选择图片。</span>
                <label className="image-list-check-label">
                  <input
                    type="checkbox"
                    checked={selection.allSelected}
                    disabled={interfaceBusy}
                    onChange={(event) => selection.selectAll(event.target.checked, interfaceBusy)}
                  />
                  全选
                </label>
                <span className={`image-list-selection-status${selection.selected.length ? "" : " is-empty"}`} role="status">
                  {selection.selected.length ? `已选 ${selection.selected.length}` : "未选择图片"}
                </span>
              </div>
              <div className="image-list-toolbar-actions">
                <ImageListViewControls
                  sort={sort}
                  thumbnailFit={thumbnailFit}
                  disabled={interfaceBusy}
                  onSortChange={changeSort}
                  onThumbnailFitChange={setThumbnailFit}
                />
                <div className="image-list-batch-actions">
                  {membershipButton("group-add", selectedFor("group-add"), "加入分组", selection.selected.length > 0 && !selectedFor("group-add").length, true)}
                  {membershipButton("group-remove", selectedFor("group-remove"), "移出分组", selection.selected.length > 0 && !selectedFor("group-remove").length, true)}
                </div>
              </div>
            </div>
          </div>
        </WorkspaceToolbar>
      </header>
      <div key={`grid:${navigation.scopeKey}:${navigation.pageNumber}`} className="admin-scroll-region" ref={gridRef} data-workspace-content="">
        <div className="admin-image-grid" data-thumbnail-fit={thumbnailFit}>
          {navigation.items.map((item) => (
            <AdminImageCard
              key={item.id}
              item={item}
              storageName={storageName}
              checked={selection.selected.includes(item.id)}
              metadata={cardMetadata(item)}
              busy={writing}
              actionsDisabled={interfaceBusy}
              detailDisabled={interfaceBusy}
              detailPending={detail.pendingItemId === item.id}
              onPreloadDetail={detail.preload}
              onDetail={(opener) => { void detail.open(item, opener); }}
              onCheck={(checked, extendRange) => selection.update(item.id, checked, extendRange, interfaceBusy)}
              onSelectRange={() => selection.update(item.id, true, true, interfaceBusy)}
              rangeSelectionHelpId={selectionHelpId}
              actions={(
                <>
                  {view === "picker" && membershipButton("group-add", [item.id], `加入分组：${imageDisplayTitle(item)}`, item.in_group)}
                  {membershipButton("group-remove", [item.id], `移出分组：${imageDisplayTitle(item)}`, view === "picker" && !item.in_group)}
                </>
              )}
            />
          ))}
          {groups.isError && <QueryErrorState error={groups.error} onRetry={() => void groups.refetch()} reportContext="group_detail.group_load" />}
          {navigation.isError && <QueryErrorState error={navigation.error} onRetry={() => void navigation.refetch()} reportContext="group_detail.images_load" />}
          {(groups.isPending || navigation.isFetching) && !navigation.items.length && <p className="muted">加载中</p>}
          {group && !navigation.isError && !navigation.isFetching && !navigation.items.length && <p className="muted">暂无图片</p>}
        </div>
      </div>
      <OverlayScrollbar key={`scrollbar:${navigation.scopeKey}:${navigation.pageNumber}`} targetRef={gridRef} pageEdge />
      <AdminPagination
        ariaLabel="分组图片分页"
        page={navigation.pageNumber}
        totalPages={navigation.totalPages}
        disabled={interfaceBusy || navigation.isFetching}
        nextDisabled={navigation.pageNumber >= navigation.totalPages}
        onPageChange={(page) => navigation.loadPage(page, interfaceBusy)}
      />
      {detail.item && detail.Modal && (
        <detail.Modal
          item={detail.item}
          admin
          storageLabel={storageName(detail.item)}
          onClose={detail.close}
          returnFocusRef={detail.returnFocusRef}
        />
      )}
      {idInput && (
        <idInput.module.ImageIdInputDialog
          groupSlug={slug}
          intent={idInput.intent}
          onClose={() => setIdInput(null)}
          onResolved={openResolvedImages}
          returnFocusRef={openerRef}
        />
      )}
      {editor.session && (
        <editor.session.module.ImageMetadataEditorDialog
          items={editor.session.items}
          intent={editor.session.intent}
          fromDialog={editor.session.fromDialog}
          pageSize={settings.ingestion.list_page_size}
          themes={editor.session.vocabulary.themes}
          allTags={editor.session.vocabulary.tags}
          authors={editor.session.vocabulary.authors}
          onClose={editor.close}
          onMembershipChange={(ids) => changeMembership(editor.session!.intent === "group-add" ? "group-add" : "group-remove", ids)}
          returnFocusRef={editor.returnFocusRef}
        />
      )}
      {feedback && <ActionFeedbackOutlet feedback={feedback} target={feedbackTarget} onClose={() => setFeedback(null)} />}
      <WorkspaceToolbarScrollbar />
    </section>
  );
}
