import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ImportVocabularyDto } from "@imageshow/shared/browser";
import {
  api,
  clearCsrfToken,
  isApiClientError
} from "../../lib/api/client.js";
import { imageEditSnapshotQueryOptions } from "../../lib/api/image-edit.js";
import { importVocabularyQueryOptions } from "../../lib/api/import-vocabulary.js";
import {
  invalidateImageData,
  invalidateImageDataAfterDelete
} from "../../lib/api/query-invalidation.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import {
  clearSessionProbeHint,
  hasSessionProbeHint,
  useAuthMe
} from "../../lib/api/site-data.js";
import {
  storageOptionsQueryOptions,
  useStorageNameResolver
} from "../../lib/api/storage-options.js";
import { errorMessage, formatDate } from "../../lib/ui/formatters.js";
import { Icon } from "../icon/Icon.js";
import type {
  AdminImageDetailItem,
  BatchEditableImageSnapshot,
  ImageAdminInfo,
  ImageItem
} from "../../lib/types.js";
// 公开详情可在已确认的管理员会话中独立加载本模块；管理色契约必须跟随能力块，
// 不能依赖访问 AdminShell 后碰巧留在文档里的样式。
import "../../styles/admin/semantic-colors.css";
import "../../styles/admin/image-details.css";

const MD5_RESERVE = "0".repeat(32);

type AdminDetailSource = AdminImageDetailItem & Partial<ImageItem>;
type ImageEditModule = typeof import("../../pages/admin/ImageEditModal.js");

type PreparedImageEdit = {
  editorModule: ImageEditModule;
  item: BatchEditableImageSnapshot;
  vocabulary: ImportVocabularyDto;
};

let imageEditModulePromise: Promise<ImageEditModule> | undefined;

function loadImageEditModule() {
  if (!imageEditModulePromise) {
    imageEditModulePromise = import("../../pages/admin/ImageEditModal.js")
      .catch((error: unknown) => {
        imageEditModulePromise = undefined;
        throw error;
      });
  }
  return imageEditModulePromise;
}

class ImageNotEditableError extends Error {
  constructor() {
    super("图片当前不可编辑");
    this.name = "ImageNotEditableError";
  }
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

function editableSnapshotFromAdminItem(
  item: AdminDetailSource | null
): BatchEditableImageSnapshot | null {
  if (!item || item.deleted_at) return null;
  if (item.status && item.status !== "ready") return null;
  if (
    !("original" in item)
    || typeof item.original !== "string"
    || !("object_key" in item)
    || typeof item.object_key !== "string"
  ) {
    return null;
  }
  return item as BatchEditableImageSnapshot;
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
  onItemUpdated,
  onItemDeleteCommitted,
  onItemDeleted,
  onNestedDialogChange
}: {
  imageId: string;
  adminItem: AdminDetailSource | null;
  onItemUpdated?: (item: BatchEditableImageSnapshot) => void;
  onItemDeleteCommitted?: (
    imageId: string
  ) => void | Promise<void>;
  onItemDeleted?: (imageId: string) => void;
  onNestedDialogChange?: (open: boolean) => void;
}) {
  const admin = Boolean(adminItem);
  const queryClient = useQueryClient();
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const preparationRef = useRef<Promise<PreparedImageEdit> | null>(null);
  const deletedImageRef = useRef<string | null>(null);
  const directSnapshot = useMemo(
    () => editableSnapshotFromAdminItem(adminItem),
    [adminItem]
  );
  const knownUneditable = Boolean(
    adminItem?.deleted_at
      || (adminItem?.status && adminItem.status !== "ready")
  );

  // 后台详情已有 Shell 确认过会话；公共详情只在本地提示存在时探测，并等服务端确认后
  // 才渲染管理入口。/auth/me 同时建立后续 POST 所需的 CSRF 状态。
  const [accessAvailable, setAccessAvailable] = useState(
    () => admin || hasSessionProbeHint()
  );
  const authQuery = useAuthMe(!admin && accessAvailable);
  const accessConfirmed = admin || authQuery.data?.authenticated === true;
  const [expanded, setExpanded] = useState(() => admin);
  const [editSuppressed, setEditSuppressed] = useState(false);
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState("");
  const [preparedEdit, setPreparedEdit] = useState<PreparedImageEdit | null>(null);
  const [refreshedAdminInfo, setRefreshedAdminInfo] =
    useState<ImageAdminInfo | null>(null);

  const denyAdminAccess = useCallback((clearSession: boolean) => {
    if (clearSession) {
      clearCsrfToken();
      clearSessionProbeHint();
    }
    preparationRef.current = null;
    setPreparedEdit(null);
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
    enabled: !admin && accessConfirmed && expanded
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

  const editOpen = preparedEdit !== null;
  useLayoutEffect(() => {
    onNestedDialogChange?.(editOpen);
    return () => {
      if (editOpen) onNestedDialogChange?.(false);
    };
  }, [editOpen, onNestedDialogChange]);

  const canEdit = accessConfirmed && !knownUneditable && !editSuppressed;
  const handlePreparationFailure = useCallback((error: unknown) => {
    if (error instanceof ImageNotEditableError) {
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

  const prepareEdit = useCallback(() => {
    if (!canEdit) return Promise.reject(new ImageNotEditableError());
    if (preparationRef.current) return preparationRef.current;

    const itemReady = directSnapshot
      ? Promise.resolve(directSnapshot)
      : queryClient.fetchQuery(imageEditSnapshotQueryOptions(imageId))
        .then((response) => {
          const item = response.items.find((candidate) => candidate.id === imageId);
          if (!item) throw new ImageNotEditableError();
          return item;
        });
    const pending = Promise.all([
      loadImageEditModule(),
      queryClient.fetchQuery(importVocabularyQueryOptions),
      queryClient.fetchQuery(storageOptionsQueryOptions),
      itemReady
    ]).then(([editorModule, vocabulary, , item]) => ({
      editorModule,
      vocabulary,
      item
    }));
    preparationRef.current = pending;
    void pending.catch((error: unknown) => {
      if (preparationRef.current === pending) preparationRef.current = null;
      handlePreparationFailure(error);
    });
    return pending;
  }, [
    canEdit,
    directSnapshot,
    handlePreparationFailure,
    imageId,
    queryClient
  ]);

  const prefetchEdit = useCallback(() => {
    if (!canEdit) return;
    void prepareEdit().catch(() => undefined);
  }, [canEdit, prepareEdit]);

  const openEdit = useCallback(async () => {
    setEditError("");
    setEditPending(true);
    try {
      setPreparedEdit(await prepareEdit());
    } catch (error) {
      if (!(error instanceof ImageNotEditableError) && accessAvailable) {
        setEditError(errorMessage(error));
      }
    } finally {
      setEditPending(false);
    }
  }, [accessAvailable, prepareEdit]);

  const closeEdit = useCallback(() => {
    const deletedImageId = deletedImageRef.current;
    deletedImageRef.current = null;
    preparationRef.current = null;
    setPreparedEdit(null);
    setEditError("");
    if (deletedImageId) onItemDeleted?.(deletedImageId);
  }, [onItemDeleted]);

  const refreshAfterSave = useCallback(async (
    authoritativeItems?: BatchEditableImageSnapshot[] | null
  ) => {
    // 所有详情与列表共享这一处失效；随后读取单图权威快照，只用于立即更新仍打开的
    // 详情和可能继续停留的失败编辑会话。后台详情同时回读轻量管理信息，以更新快照
    // 契约刻意不承载的 updated_at；两条读取并行，且不触发第二轮全局失效。
    await invalidateImageData(queryClient);
    const snapshotRequest = authoritativeItems
      ? Promise.resolve({ items: authoritativeItems })
      : queryClient.fetchQuery({
          ...imageEditSnapshotQueryOptions(imageId),
          staleTime: 0
        });
    const adminInfoRequest: Promise<ImageAdminInfo | null> = admin
      ? queryClient.fetchQuery({
          ...adminImageInfoQueryOptions(imageId),
          staleTime: 0
        })
      : Promise.resolve(null);
    const [snapshotResult, adminInfoResult] = await Promise.allSettled([
      snapshotRequest,
      adminInfoRequest
    ]);

    if (snapshotResult.status === "rejected") {
      handlePreparationFailure(snapshotResult.reason);
      throw snapshotResult.reason;
    }
    const response = snapshotResult.value;
    const item = response.items.find((candidate) => candidate.id === imageId);
    if (!item) {
      setEditSuppressed(true);
      setPreparedEdit(null);
      return;
    }
    onItemUpdated?.(item);
    setPreparedEdit((current) => current
      ? { ...current, item }
      : current);
    preparationRef.current = null;

    if (adminInfoResult.status === "rejected") {
      handlePreparationFailure(adminInfoResult.reason);
      throw adminInfoResult.reason;
    }
    if (adminInfoResult.value?.id === imageId) {
      setRefreshedAdminInfo(adminInfoResult.value);
    }
  }, [
    admin,
    handlePreparationFailure,
    imageId,
    onItemUpdated,
    queryClient
  ]);
  const refreshAfterDelete = useCallback(async () => {
    // mutation 已经由内层编辑器确认提交；先让公开详情的查询所有者禁用当前 ID，
    // 再取消读取并刷新派生投影，避免关闭动画期间被聚焦或网络重连重新拉取 404。
    let refreshError: unknown;
    try {
      await onItemDeleteCommitted?.(imageId);
      // 页面仍由详情与编辑器共同锁定滚动时刷新派生投影；公开列表已经在
      // mutation 成功边界局部更新，不重放已加载的历史游标页。
      await invalidateImageDataAfterDelete(queryClient, imageId);
    } catch (error) {
      refreshError = error;
    }

    preparationRef.current = null;
    setEditSuppressed(true);
    setEditError("");
    // 先让内层编辑器走完自己的退出动画；其 onClose 再通知外层详情关闭，
    // 避免最短 pending 时长尚未结束时由父级卸载内层并遗留迟到的关闭定时器。
    deletedImageRef.current = imageId;

    if (refreshError) throw refreshError;
  }, [imageId, onItemDeleteCommitted, queryClient]);

  // 存储选项只属于管理信息；留在这个按需块内，匿名公开详情不会下载后台查询实现。
  const storageName = useStorageNameResolver(admin);

  if (!accessAvailable || !accessConfirmed) return null;

  const loading = !admin && query.isFetching && !adminInfo;
  const failed = !admin && query.isError && !query.isFetching;
  const fallback = unresolvedValue(admin, loading, failed);
  const md5 = refreshedAdminInfo?.md5 || adminItem?.md5 || adminInfo?.md5 || fallback;
  const storage = refreshedAdminInfo?.storage_label
    || (adminItem
      ? storageName(adminItem) || fallback
      : adminInfo?.storage_label || fallback);
  const createdAt =
    refreshedAdminInfo?.created_at ?? adminItem?.created_at ?? adminInfo?.created_at;
  const updatedAt =
    refreshedAdminInfo?.updated_at ?? adminItem?.updated_at ?? adminInfo?.updated_at;
  const prefetchAdminInfo = () => {
    if (admin || !accessConfirmed) return;
    void queryClient.prefetchQuery(adminInfoOptions);
  };
  const EditModal = preparedEdit?.editorModule.ImageEditModal;

  return (
    <section className="image-detail-admin-details">
      <div className="image-detail-admin-actions">
        <button
          type="button"
          className="image-detail-admin-toggle pressable"
          aria-expanded={expanded}
          onPointerEnter={prefetchAdminInfo}
          onFocus={prefetchAdminInfo}
          onPointerDown={prefetchAdminInfo}
          onClick={() => setExpanded((current) => !current)}
        >
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          管理信息
        </button>
        {canEdit && (
          <button
            ref={editButtonRef}
            type="button"
            className="icon image-detail-edit-button pressable"
            aria-label="编辑图片"
            title="编辑图片"
            aria-busy={editPending || undefined}
            disabled={editPending}
            onPointerEnter={prefetchEdit}
            onFocus={prefetchEdit}
            onPointerDown={prefetchEdit}
            onClick={() => void openEdit()}
          >
            <Icon name="pencil-line" />
          </button>
        )}
      </div>
      {editError && (
        <p className="image-detail-edit-error" role="alert" title={editError}>
          编辑器加载失败，请重试
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
            {adminItem?.deleted_at && <><dt>删除时间</dt><dd>{formatDate(adminItem.deleted_at)}</dd></>}
          </dl>
          {failed && (
            <div className="image-detail-admin-error" role="alert" title={errorMessage(query.error)}>
              <span>管理信息加载失败</span>
              <button type="button" onClick={() => void query.refetch()}>重试</button>
            </div>
          )}
        </div>
      )}
      {preparedEdit && EditModal && (
        <EditModal
          item={preparedEdit.item}
          themes={preparedEdit.vocabulary.themes}
          allTags={preparedEdit.vocabulary.tags}
          authors={preparedEdit.vocabulary.authors}
          onClose={closeEdit}
          onSaved={refreshAfterSave}
          onDeleted={refreshAfterDelete}
          returnFocusRef={editButtonRef}
        />
      )}
    </section>
  );
}
