import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  clearCsrfToken,
  isApiClientError
} from "../../lib/api/client.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import {
  clearSessionProbeHint
} from "../../lib/api/auth-session.js";
import { useAuthMe } from "../../hooks/useAuthSession.js";
import {
  isImageNotEditableError,
  type ImageEditorTarget,
  type ImageMetadataSaveCommit
} from "./editor/image-editor-capability-loader.js";
import { errorMessage, formatDate } from "../../lib/ui/formatters.js";
import { preloadIntentProps } from "../../lib/ui/preload-intent.js";
import { storageBackendLabel } from "../../lib/ui/select-options.js";
import { useImageEditorCapability } from "./editor/useImageEditorCapability.js";
import { Icon } from "../icon/Icon.js";
import type {
  AdminImageDetailItem,
  EditableImageSnapshot,
  ImageAdminInfo,
  AdminImageListItem
} from "../../lib/types.js";
// 公开详情可在已确认的管理员会话中独立加载本模块；这里只带入管理详情自身样式，
// 完整的管理表单色契约继续等到用户明确打开编辑器时再加载。
import "../../styles/admin/image-details.css";

const MD5_RESERVE = "0".repeat(32);

type AdminDetailSource = AdminImageDetailItem | AdminImageListItem;

function isAdminImageListItem(
  item: AdminDetailSource
): item is AdminImageListItem {
  return "status" in item;
}

function adminImageInfoQueryOptions(imageId: string) {
  return queryOptions<ImageAdminInfo>({
    queryKey: [...queryKeys.adminImageInfo, imageId],
    queryFn: ({ signal }) => api(`${adminApiBasePath}/images/${encodeURIComponent(imageId)}/admin-info`, { signal }),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000
  });
}

function unresolvedValue(admin: boolean, loading: boolean, failed: boolean) {
  if (admin) return "未记录";
  if (loading) return "加载中…";
  if (failed) return "加载失败";
  return "未记录";
}

export function ImageAdminDetails({
  imageId,
  adminItem,
  adminStorageLabel,
  onItemUpdated,
  onItemRefreshRequested,
  onItemTrashCommitted,
  onItemTrashed,
  onNestedDialogChange
}: {
  imageId: string;
  adminItem: AdminDetailSource | null;
  adminStorageLabel?: string;
  onItemUpdated?: (item: EditableImageSnapshot) => void;
  onItemRefreshRequested?: (imageId: string) => void;
  onItemTrashCommitted?: (
    imageId: string
  ) => void | Promise<void>;
  onItemTrashed?: (imageId: string) => void;
  onNestedDialogChange?: (open: boolean) => void;
}) {
  const admin = Boolean(adminItem);
  const adminListItem = adminItem && isAdminImageListItem(adminItem)
    ? adminItem
    : null;
  const queryClient = useQueryClient();
  const trashedImageRef = useRef<string | null>(null);
  const knownUneditable = Boolean(
    adminListItem?.deleted_at
      || (adminListItem && adminListItem.status !== "ready")
  );

  // 后台详情已有 Shell 确认过会话；公共详情只有在外层根据 /auth/me 的
  // 权威结果加载本模块后才可能渲染管理入口。本地 session hint 仅负责触发
  // AuthSessionProvider 探测，不能成为本模块的访问依据。
  const authQuery = useAuthMe();
  const [accessAvailable, setAccessAvailable] = useState(
    () => admin || authQuery.data?.authenticated === true
  );
  const accessConfirmed = admin || authQuery.data?.authenticated === true;
  const [expanded, setExpanded] = useState(() => admin);
  const [editSuppressed, setEditSuppressed] = useState(false);
  const [editError, setEditError] = useState("");
  const [editNotice, setEditNotice] = useState("");
  const [migratedStorageLabel, setMigratedStorageLabel] = useState("");
  const [refreshedAdminInfo, setRefreshedAdminInfo] =
    useState<ImageAdminInfo | null>(null);

  const denyAdminAccess = useCallback((clearSession: boolean) => {
    if (clearSession) {
      clearCsrfToken();
      clearSessionProbeHint();
    }
    setAccessAvailable(false);
    setExpanded(false);
  }, []);

  useEffect(() => {
    if (admin || !authQuery.data || authQuery.data.authenticated) return;
    denyAdminAccess(true);
  }, [admin, authQuery.data, denyAdminAccess]);

  useEffect(() => {
    if (
      admin
      || !isApiClientError(authQuery.error)
      || (authQuery.error.status !== 401 && authQuery.error.status !== 403)
    ) {
      return;
    }
    denyAdminAccess(authQuery.error.status === 401);
  }, [admin, authQuery.error, denyAdminAccess]);

  const adminInfoOptions = adminImageInfoQueryOptions(imageId);
  const query = useQuery({
    ...adminInfoOptions,
    enabled: accessConfirmed && expanded && (!admin || !adminStorageLabel)
  });
  const adminInfo = query.data?.id === imageId ? query.data : undefined;

  useEffect(() => {
    if (
      admin
      || !isApiClientError(query.error)
      || (query.error.status !== 401 && query.error.status !== 403)
    ) {
      return;
    }
    denyAdminAccess(query.error.status === 401);
  }, [admin, denyAdminAccess, query.error]);

  const canEdit = accessConfirmed && !knownUneditable && !editSuppressed;
  const handlePreparationFailure = useCallback((error: unknown) => {
    if (isImageNotEditableError(error)) {
      setEditSuppressed(true);
      return;
    }
    if (
      isApiClientError(error)
      && (error.status === 401 || error.status === 403)
    ) {
      denyAdminAccess(error.status === 401);
    }
  }, [denyAdminAccess]);
  const editTarget = useMemo<ImageEditorTarget>(() => ({
    sources: [adminItem ?? { id: imageId }]
  }), [adminItem, imageId]);
  const editorCapability = useImageEditorCapability({
    onPreparationError: handlePreparationFailure,
    onOpenError: (error) => {
      if (!isImageNotEditableError(error) && accessAvailable) {
        setEditError(errorMessage(error));
      }
    }
  });
  const editOpen = editorCapability.session !== null;
  const editPending = editorCapability.pending !== null;

  useEffect(() => {
    if (!accessAvailable) editorCapability.reset();
  }, [accessAvailable, editorCapability.reset]);

  useLayoutEffect(() => {
    onNestedDialogChange?.(editOpen);
    return () => {
      if (editOpen) onNestedDialogChange?.(false);
    };
  }, [editOpen, onNestedDialogChange]);

  const prefetchEdit = useCallback(() => {
    if (!canEdit) return;
    editorCapability.preload(editTarget);
  }, [canEdit, editTarget, editorCapability.preload]);

  const openEdit = useCallback((opener: HTMLElement) => {
    if (!canEdit) return;
    setEditError("");
    setEditNotice("");
    void editorCapability.open(editTarget, opener);
  }, [canEdit, editTarget, editorCapability.open]);

  const closeEdit = useCallback(() => {
    const trashedImageId = trashedImageRef.current;
    trashedImageRef.current = null;
    editorCapability.close();
    setEditError("");
    if (trashedImageId) onItemTrashed?.(trashedImageId);
  }, [editorCapability.close, onItemTrashed]);

  const loadAdminInfoAfterInvalidation = useCallback(async () => {
    // 后台入口直接传入首帧存储显示名，因此平时不启用 admin-info Query。公开详情
    // 在展开管理信息后会启用它；精确图片信息失效已经等待该 active Query 完成刷新，
    // 这里优先复用结果，避免随后再以同一个 key 发起第二次请求。后台保存或迁移后
    // 仍按需读取一次 updated_at 与权威存储显示名。
    if (expanded && !adminStorageLabel) {
      const queryState = queryClient.getQueryState<ImageAdminInfo>(
        adminImageInfoQueryOptions(imageId).queryKey
      );
      if (queryState?.error) throw queryState.error;
      if (queryState?.data) return queryState.data;
    }
    return queryClient.fetchQuery({
      ...adminImageInfoQueryOptions(imageId),
      staleTime: 0
    });
  }, [adminStorageLabel, expanded, imageId, queryClient]);

  const refreshAfterSave = useCallback(async (
    commit?: ImageMetadataSaveCommit
  ) => {
    // 元数据保存已经在 mutation 边界取得权威快照，先原位更新当前详情和 Gallery
    // 卡片，再按实际字段失效其余投影。存储迁移没有这份提交上下文，仍走完整回读。
    const capabilityModule = editorCapability.session?.module;
    if (!capabilityModule) throw new Error("图片编辑能力未加载");
    if (commit === undefined) {
      // 无 commit 的保存回调只来自存储迁移。先丢弃此前操作留下的相邻信息与
      // 目标兜底，确保本轮 admin-info 成功时优先采用其最新显示名；只有本轮
      // 回读失败时，才由迁移响应携带的服务端目标显示名收口。
      setRefreshedAdminInfo(null);
      setMigratedStorageLabel("");
    }
    const committedForCurrent = commit?.updates.some(
      (update) => update.id === imageId
    ) === true;
    const applySnapshot = (item: EditableImageSnapshot) => {
      onItemUpdated?.(item);
      editorCapability.updateItems([item]);
    };
    const immediateItem = committedForCurrent
      ? commit?.authoritativeItems?.find(
          (candidate) => candidate.id === imageId
        )
      : undefined;
    if (immediateItem) {
      applySnapshot(immediateItem);
    } else if (committedForCurrent) {
      onItemRefreshRequested?.(imageId);
    }
    const { snapshotResult, adjacentDataResult } =
      await capabilityModule.refreshImageEditorAfterSave<ImageAdminInfo>({
        queryClient,
        imageIds: [imageId],
        commit,
        loadAdjacentData: admin || commit === undefined
          ? loadAdminInfoAfterInvalidation
          : undefined
      });

    if (
      adjacentDataResult.status === "fulfilled"
      && adjacentDataResult.value?.id === imageId
    ) {
      setRefreshedAdminInfo(adjacentDataResult.value);
    }
    if (snapshotResult.status === "rejected") {
      handlePreparationFailure(snapshotResult.reason);
      if (adjacentDataResult.status === "rejected") {
        handlePreparationFailure(adjacentDataResult.reason);
      }
      throw snapshotResult.reason;
    }
    const response = snapshotResult.value;
    const item = response.items.find((candidate) => candidate.id === imageId);
    const shouldApplySnapshot = commit === undefined || committedForCurrent;
    if (shouldApplySnapshot && !item) {
      setEditSuppressed(true);
      return;
    }
    if (item && item !== immediateItem && shouldApplySnapshot) {
      applySnapshot(item);
    }

    if (adjacentDataResult.status === "rejected") {
      handlePreparationFailure(adjacentDataResult.reason);
      throw adjacentDataResult.reason;
    }
  }, [
    admin,
    editorCapability.session,
    editorCapability.updateItems,
    handlePreparationFailure,
    imageId,
    loadAdminInfoAfterInvalidation,
    onItemRefreshRequested,
    onItemUpdated,
    queryClient
  ]);
  const commitEditorTrashMembership = useCallback(async (
    imageIds: string[]
  ) => {
    let membershipError: unknown;
    if (onItemTrashCommitted) {
      try {
        for (const committedId of imageIds) {
          await onItemTrashCommitted(committedId);
        }
      } catch (error) {
        membershipError = error;
      }
    }

    if (imageIds.includes(imageId)) {
      setEditSuppressed(true);
      setEditError("");
      // 先让内层编辑器走完自己的退出动画；其 onClose 再通知外层详情关闭，
      // 避免最短 pending 时长尚未结束时由父级卸载内层并遗留迟到的关闭定时器。
      trashedImageRef.current = imageId;
    }
    if (membershipError) throw membershipError;
  }, [imageId, onItemTrashCommitted]);

  if (!accessAvailable || !accessConfirmed) return null;

  const loading = !admin && query.isFetching && !adminInfo;
  const failed = !admin && query.isError && !query.isFetching;
  const fallback = unresolvedValue(admin, loading, failed);
  const md5 = refreshedAdminInfo?.md5 || adminItem?.md5 || adminInfo?.md5 || fallback;
  const refreshedPublicStorageLabel = !admin
    && !query.isStale
    && !query.isError
    ? adminInfo?.storage_label
    : undefined;
  // 迁移接口已经确认目标后端时，该显示名比打开详情时的首帧标签更新。
  // 后台详情以本轮显式回读优先；公开详情复用 active Query 的失效刷新，只有
  // Query 已成功收敛为 fresh 时才优先。刷新中或失败时不能退回旧存储名。
  const storage = refreshedAdminInfo?.storage_label
    || refreshedPublicStorageLabel
    || migratedStorageLabel
    || adminStorageLabel
    || adminInfo?.storage_label
    || (adminListItem
      ? storageBackendLabel(adminListItem.storage_slug)
      : fallback);
  const createdAt =
    refreshedAdminInfo?.created_at ?? adminItem?.created_at ?? adminInfo?.created_at;
  const updatedAt =
    refreshedAdminInfo?.updated_at ?? adminItem?.updated_at ?? adminInfo?.updated_at;
  const prefetchAdminInfo = () => {
    if (admin || !accessConfirmed) return;
    void queryClient.prefetchQuery(adminInfoOptions);
  };
  const MetadataEditorModal =
    editorCapability.session?.module.ImageMetadataEditorDialog;

  return (
    <section className="image-detail-admin-details">
      <div className="image-detail-admin-actions">
        <button
          type="button"
          className="image-detail-admin-toggle pressable"
          aria-expanded={expanded}
          {...preloadIntentProps(prefetchAdminInfo)}
          onClick={() => setExpanded((current) => !current)}
        >
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          管理信息
        </button>
        {canEdit && (
          <button
            type="button"
            className="icon image-detail-edit-button pressable"
            aria-label="编辑图片"
            title="编辑图片"
            aria-busy={editPending || undefined}
            disabled={editPending}
            {...preloadIntentProps(prefetchEdit)}
            onClick={(event) => openEdit(event.currentTarget)}
          >
            <Icon name="pencil-line" />
          </button>
        )}
      </div>
      {editError && (
        <p className="image-detail-edit-error" role="alert" title={editError}>
          编辑器加载失败，请重新加载页面
        </p>
      )}
      {editNotice && (
        <p className="image-detail-edit-notice" role="status">
          {editNotice}
        </p>
      )}
      {expanded && (
        <div className="image-detail-admin-panel">
          <dl>
            <dt>UUID</dt><dd className="image-detail-admin-uuid">{imageId}</dd>
            <dt>MD5</dt>
            <dd className="image-detail-admin-md5">
              <span className="image-detail-admin-md5-reserve" aria-hidden="true">{MD5_RESERVE}</span>
              <span>{md5}</span>
            </dd>
            <dt>存储</dt><dd>{storage}</dd>
            <dt>导入时间</dt><dd>{createdAt ? formatDate(createdAt) : fallback}</dd>
            <dt>更新时间</dt><dd>{updatedAt ? formatDate(updatedAt) : fallback}</dd>
            {adminListItem?.deleted_at && <><dt>删除时间</dt><dd>{formatDate(adminListItem.deleted_at)}</dd></>}
          </dl>
          {failed && (
            <div className="image-detail-admin-error" role="alert" title={errorMessage(query.error)}>
              <span>管理信息加载失败</span>
              <button type="button" onClick={() => void query.refetch()}>重试</button>
            </div>
          )}
        </div>
      )}
      {editorCapability.session && MetadataEditorModal && (
        <MetadataEditorModal
          items={editorCapability.session.items}
          pageSize={1}
          themes={editorCapability.session.vocabulary.themes}
          allTags={editorCapability.session.vocabulary.tags}
          authors={editorCapability.session.vocabulary.authors}
          onClose={closeEdit}
          onTrashCommitted={commitEditorTrashMembership}
          publicImageMembershipHandled={!admin}
          onSaved={refreshAfterSave}
          onStorageMigrationSucceeded={(message, storageLabel) => {
            setMigratedStorageLabel(storageLabel);
            setEditNotice(message);
          }}
          returnFocusRef={editorCapability.returnFocusRef}
        />
      )}
    </section>
  );
}
