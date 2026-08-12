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
  type ImageEditorTarget
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
  onItemTrashCommitted,
  onItemTrashed,
  onNestedDialogChange
}: {
  imageId: string;
  adminItem: AdminDetailSource | null;
  adminStorageLabel?: string;
  onItemUpdated?: (item: EditableImageSnapshot) => void;
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
    // Overview 等未直接持有存储显示名的后台详情会启用上面的 admin-info
    // Query。全局图片失效已经等待这个 active Query 完成刷新；优先复用它的
    // 结果，避免随后再以同一个 key 发起第二次请求。ImageAdmin 传入显示名时
    // 该 Query 未启用，保存后仍在这里按需读取一次 updated_at 与存储显示名。
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
    authoritativeItems?: EditableImageSnapshot[] | null
  ) => {
    // 所有详情与列表共享这一处失效；随后读取单图权威快照，只用于立即更新仍打开的
    // 详情和可能继续停留的失败编辑会话。后台详情同时回读轻量管理信息，以更新快照
    // 契约刻意不承载的 updated_at；两条读取并行，且不触发第二轮全局失效。
    const capabilityModule = editorCapability.session?.module;
    if (!capabilityModule) throw new Error("图片编辑能力未加载");
    const { snapshotResult, adjacentDataResult } =
      await capabilityModule.refreshImageEditorAfterSave<ImageAdminInfo>({
        queryClient,
        imageIds: [imageId],
        authoritativeItems,
        loadAdjacentData: admin
          ? loadAdminInfoAfterInvalidation
          : undefined
      });

    if (snapshotResult.status === "rejected") {
      handlePreparationFailure(snapshotResult.reason);
      throw snapshotResult.reason;
    }
    const response = snapshotResult.value;
    const item = response.items.find((candidate) => candidate.id === imageId);
    if (!item) {
      setEditSuppressed(true);
      return;
    }
    onItemUpdated?.(item);
    editorCapability.updateItems([item]);

    if (adjacentDataResult.status === "rejected") {
      handlePreparationFailure(adjacentDataResult.reason);
      throw adjacentDataResult.reason;
    }
    if (adjacentDataResult.value?.id === imageId) {
      setRefreshedAdminInfo(adjacentDataResult.value);
    }
  }, [
    admin,
    editorCapability.session,
    editorCapability.updateItems,
    handlePreparationFailure,
    imageId,
    loadAdminInfoAfterInvalidation,
    onItemUpdated,
    queryClient
  ]);
  const refreshAfterTrash = useCallback(async (imageIds: string[]) => {
    // mutation 已经由内层编辑器确认提交；先让公开详情的查询所有者禁用当前 ID，
    // 再取消读取并刷新派生投影，避免关闭动画期间被聚焦或网络重连重新拉取 404。
    let refreshError: unknown;
    try {
      const capabilityModule = editorCapability.session?.module;
      if (!capabilityModule) throw new Error("图片编辑能力未加载");
      // 页面仍由详情与编辑器共同锁定滚动时刷新派生投影；公开列表已经在
      // mutation 成功边界局部更新，不重放已加载的历史游标页。
      await capabilityModule.refreshImageEditorAfterTrash({
        queryClient,
        imageIds,
        onTrashCommitted: onItemTrashCommitted
          ? async (committedIds) => {
              for (const committedId of committedIds) {
                await onItemTrashCommitted(committedId);
              }
            }
          : undefined
      });
    } catch (error) {
      refreshError = error;
    }

    if (!imageIds.includes(imageId)) return;
    setEditSuppressed(true);
    setEditError("");
    // 先让内层编辑器走完自己的退出动画；其 onClose 再通知外层详情关闭，
    // 避免最短 pending 时长尚未结束时由父级卸载内层并遗留迟到的关闭定时器。
    trashedImageRef.current = imageId;

    if (refreshError) throw refreshError;
  }, [
    editorCapability.session,
    imageId,
    onItemTrashCommitted,
    queryClient
  ]);

  if (!accessAvailable || !accessConfirmed) return null;

  const loading = !admin && query.isFetching && !adminInfo;
  const failed = !admin && query.isError && !query.isFetching;
  const fallback = unresolvedValue(admin, loading, failed);
  const md5 = refreshedAdminInfo?.md5 || adminItem?.md5 || adminInfo?.md5 || fallback;
  const storage = refreshedAdminInfo?.storage_label
    || adminStorageLabel
    || adminInfo?.storage_label
    || (adminItem ? storageBackendLabel(adminItem.storage_slug) : fallback);
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
          onTrashed={refreshAfterTrash}
          onSaved={refreshAfterSave}
          onStorageMigrationSucceeded={setEditNotice}
          returnFocusRef={editorCapability.returnFocusRef}
        />
      )}
    </section>
  );
}
