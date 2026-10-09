import {
  imageVariantUrl,
  imageOriginalUrl,
  type AdminImageDetailItemDto,
  type EditableImageSnapshotDto
} from "@imageshow/shared/browser";
import {
  Component,
  Suspense,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from "react";
import { Icon } from "../icon/Icon.js";
import { ProgressiveImage } from "./ProgressiveImage.js";
import {
  displayNameOrSlug,
  imageDisplayTitle,
  formatDate
} from "../../lib/ui/formatters.js";
import { brightnessOptionLabel, deviceOptionLabel } from "../../lib/ui/select-options.js";
import type { PublicImageItem } from "../../lib/gallery/public-image.js";
import { useGalleryFacets } from "../../lib/api/site-queries.js";
import { createGalleryTaxonomyDisplayFormatter } from "../../lib/gallery/card-display.js";
import { useOptionalAuthSessionQuery } from "../../hooks/useAuthSession.js";
import {
  mobileViewportMediaQuery,
  useMediaQuery
} from "../../hooks/useMediaQuery.js";
import { OverlayScrollbar } from "../layout/OverlayScrollbar.js";
import { ImageDescriptionSlot } from "./ImageDescriptionSlot.js";
import { DialogFrame } from "../dialog/DialogFrame.js";
import { DirectActivationButton } from "../actions/DirectActivationButton.js";
import { LazyImageAdminDetails } from "./image-admin-details-loader.js";
import type { ImageEditorTarget } from "./editor/image-editor-types.js";
import "../../styles/image-detail.css";

class ImageAdminDetailsModuleBoundary extends Component<
  {
    children: ReactNode;
    resetKey: string;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(
    previousProps: Readonly<{
      children: ReactNode;
      resetKey: string;
    }>
  ) {
    if (this.state.failed
      && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="image-detail-admin-module-error" role="alert">
          <span>管理信息加载失败</span>
          <button
            className="button secondary pressable"
            type="button"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function applyEditedSnapshot<T extends { id: string }>(
  item: T,
  snapshot: EditableImageSnapshotDto | null
): T {
  if (snapshot?.id !== item.id) return item;
  return {
    ...item,
    ...snapshot
  };
}

type ImageDetailModalProps =
  | {
      item: PublicImageItem;
      onClose: () => void;
      admin?: false;
      detailLoading?: boolean;
      detailError?: string;
      onDetailRetry?: () => void;
      onTrashCommitted?: (imageId: string) => void | Promise<void>;
      onTrashed?: (imageId: string) => void;
      onItemUpdated?: (item: EditableImageSnapshotDto) => void;
      onItemRefreshRequested?: (imageId: string) => void;
      returnFocusRef?: RefObject<HTMLElement | null>;
    }
  | {
      item: AdminImageDetailItemDto;
      onClose: () => void;
      admin: true;
      editTarget: ImageEditorTarget | null;
      deletedAt?: string | null;
      onTrashCommitted?: (imageId: string) => void | Promise<void>;
      onTrashed?: (imageId: string) => void;
      onItemUpdated?: (item: EditableImageSnapshotDto) => void;
      onItemRefreshRequested?: (imageId: string) => void;
      returnFocusRef?: RefObject<HTMLElement | null>;
    };

export function ImageDetailModal(props: ImageDetailModalProps) {
  const { onClose } = props;
  const [editedSnapshot, setEditedSnapshot] = useState<EditableImageSnapshotDto | null>(null);
  const admin = props.admin === true;
  const authQuery = useOptionalAuthSessionQuery();
  const showAdminDetails = admin
    || authQuery?.data?.authenticated === true;
  const currentSnapshot = showAdminDetails ? editedSnapshot : null;
  const item = applyEditedSnapshot(props.item, currentSnapshot);
  const adminItem = props.admin === true
    ? applyEditedSnapshot(props.item, editedSnapshot)
    : null;
  const suppliedEditTarget = props.admin ? props.editTarget : undefined;
  const editTarget = useMemo<ImageEditorTarget | null>(
    () => {
      if (!admin) return { ids: [props.item.id] };
      if (!suppliedEditTarget) return null;
      return suppliedEditTarget.items && currentSnapshot?.id === props.item.id
        ? { ...suppliedEditTarget, items: [currentSnapshot] }
        : suppliedEditTarget;
    },
    [admin, suppliedEditTarget, currentSnapshot, props.item.id]
  );
  const detailLoading = !currentSnapshot && !admin && props.detailLoading === true;
  const detailError = !currentSnapshot && !admin ? (props.detailError?.trim() ?? "") : "";
  const onDetailRetry = !admin ? props.onDetailRetry : undefined;
  const handleItemUpdated = useCallback(
    (nextItem: EditableImageSnapshotDto) => {
      setEditedSnapshot(nextItem);
      props.onItemUpdated?.(nextItem);
    },
    [props.onItemUpdated]
  );
  const handleItemRefreshRequested = useCallback(
    (imageId: string) => {
      setEditedSnapshot((current) => (current?.id === imageId ? null : current));
      props.onItemRefreshRequested?.(imageId);
    },
    [props.onItemRefreshRequested]
  );
  const mobileLayout = useMediaQuery(mobileViewportMediaQuery);
  const dialogRef = useRef<HTMLElement | null>(null);
  const desktopCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const mobileCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const detailContentRef = useRef<HTMLDivElement | null>(null);
  const titleHeaderRef = useRef<HTMLElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const [nestedDialogOpen, setNestedDialogOpen] = useState(false);
  const { data: facets } = useGalleryFacets();
  const taxonomyDisplay = useMemo(
    () => createGalleryTaxonomyDisplayFormatter(facets),
    [facets]
  );
  const authorMap = useMemo(
    () => new Map((facets?.authors ?? []).map((option) => [option.slug, option])),
    [facets]
  );

  const { themeLabel, tagLabels } = taxonomyDisplay(item);

  const authorSlug = item.author ?? "";
  const authorOption = authorSlug ? authorMap.get(authorSlug) : undefined;
  const authorLabel = authorOption ? displayNameOrSlug(authorOption) : authorSlug;
  const authorLink = authorOption?.link || "";

  const title = imageDisplayTitle(item);
  const imageTime = adminItem?.image_time ?? item.image_time;
  const sourceAvailable = Boolean(item.source);
  const sourceStateLabel = detailError
    ? "详情加载失败"
    : detailLoading
      ? "来源加载中"
      : sourceAvailable
        ? "打开来源页面"
        : "暂无来源";
  const originalHref = showAdminDetails ? imageOriginalUrl(item) : null;
  const imageAspectRatio =
    "width" in item && "height" in item && item.width > 0 && item.height > 0
      ? `${item.width} / ${item.height}`
      : item.device === "mb" ? "9 / 16" : "16 / 9";

  return (
    <DialogFrame
      className="modal image-detail-modal"
      ariaLabel="图片详情"
      colorContext={admin ? "admin" : "public"}
      closeOnBackdrop
      backdropCloseEvent="click"
      paused={nestedDialogOpen}
      initialFocusRef={mobileLayout ? mobileCloseButtonRef : desktopCloseButtonRef}
      returnFocusRef={props.returnFocusRef}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <>
          {mobileLayout && (
            <DirectActivationButton
              ref={mobileCloseButtonRef}
              className="icon close pressable image-detail-mobile-close"
              type="button"
              title="关闭"
              aria-label="关闭图片详情"
              onActivate={() => requestClose()}
            >
              <Icon name="close-line" />
            </DirectActivationButton>
          )}
          <article ref={dialogRef} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
            <ProgressiveImage
              key={item.id}
              imageKey={item.id}
              thumbSrc={imageVariantUrl(item, "small")}
              fullSrc={imageVariantUrl(item, "medium")}
              alt={title}
              className="image-detail-image"
              style={{ aspectRatio: imageAspectRatio }}
            />
            <div className="image-detail-panel">
              <div className="image-detail-content" ref={detailContentRef}>
                <header className="image-detail-head" ref={titleHeaderRef}>
                  <div className="image-detail-title-row">
                    <h2>
                      {item.base_url ? (
                        <a
                          className="image-detail-title-link"
                          href={imageVariantUrl(item, "large")}
                          target="_blank"
                          title="在新标签页打开图片直链"
                        >
                          {title}
                        </a>
                      ) : (
                        title
                      )}
                    </h2>
                    {!mobileLayout && (
                      <button
                        className="icon close pressable"
                        ref={desktopCloseButtonRef}
                        type="button"
                        title="关闭"
                        aria-label="关闭图片详情"
                        onClick={() => requestClose()}
                      >
                        <Icon name="close-line" />
                      </button>
                    )}
                  </div>
                </header>
                <ImageDescriptionSlot
                  description={item.description}
                  loading={detailLoading}
                  error={detailError}
                  onRetry={onDetailRetry}
                  boundaryRef={actionsRef}
                  inlineExpansion={mobileLayout}
                />
                <div className="image-detail-scroll-body">
                  <dl className="image-detail-public-properties">
                    {authorSlug && (
                      <>
                        <dt>作者</dt>
                        <dd>
                          {authorLink ? (
                            <a
                              href={authorLink}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {authorLabel}
                            </a>
                          ) : (
                            authorLabel
                          )}
                        </dd>
                      </>
                    )}
                    <dt>设备</dt>
                    <dd>
                      {detailLoading
                        ? "加载中"
                        : detailError
                          ? "加载失败"
                          : deviceOptionLabel(item.device)}
                    </dd>
                    <dt>亮度</dt>
                    <dd>
                      {detailLoading
                        ? "加载中"
                        : detailError
                          ? "加载失败"
                          : brightnessOptionLabel(item.brightness)}
                    </dd>
                    <dt>主题</dt>
                    <dd>{detailLoading ? "加载中" : detailError ? "加载失败" : themeLabel}</dd>
                    {item.tags.length > 0 && (
                      <>
                        <dt className="image-detail-tags-label">标签</dt>
                        <dd className="image-detail-tags">
                          {item.tags.map((tag, index) => (
                            <span key={tag} className="tag-chip">
                              {tagLabels[index]}
                            </span>
                          ))}
                        </dd>
                      </>
                    )}
                    {imageTime && (
                      <>
                        <dt>发布时间</dt>
                        <dd>{formatDate(imageTime)}</dd>
                      </>
                    )}
                  </dl>
                  <div className="inline-actions image-detail-actions" ref={actionsRef}>
                    <a
                      className={`button secondary image-detail-source${sourceAvailable ? " pressable" : " is-disabled"}`}
                      href={item.source || undefined}
                      target="_blank"
                      rel="noreferrer"
                      aria-disabled={!sourceAvailable}
                      aria-label={sourceStateLabel}
                      title={sourceStateLabel}
                      tabIndex={sourceAvailable ? undefined : -1}
                      onClick={(event) => {
                        if (!sourceAvailable) event.preventDefault();
                      }}
                    >
                      <Icon name="external-link-line" />
                      来源
                    </a>
                    {originalHref && (
                      <a
                        className="button secondary pressable image-detail-original"
                        href={originalHref}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="打开原图"
                        title="打开原图"
                      >
                        <Icon name="external-link-line" />
                        原图
                      </a>
                    )}
                  </div>
                  {showAdminDetails && (
                    <ImageAdminDetailsModuleBoundary resetKey={item.id}>
                      <Suspense fallback={null}>
                        <LazyImageAdminDetails
                          key={item.id}
                          imageId={item.id}
                          adminItem={adminItem}
                          editTarget={editTarget}
                          deletedAt={props.admin ? props.deletedAt : undefined}
                          onItemUpdated={handleItemUpdated}
                          onItemRefreshRequested={handleItemRefreshRequested}
                          onItemTrashCommitted={props.onTrashCommitted}
                          onItemTrashed={(imageId) => {
                            try {
                              props.onTrashed?.(imageId);
                            } finally {
                              requestClose();
                            }
                          }}
                          onNestedDialogChange={setNestedDialogOpen}
                        />
                      </Suspense>
                    </ImageAdminDetailsModuleBoundary>
                  )}
                </div>
              </div>
              <OverlayScrollbar
                targetRef={mobileLayout ? dialogRef : detailContentRef}
                topInsetRef={mobileLayout ? undefined : titleHeaderRef}
                enableOnTouch
              />
            </div>
          </article>
        </>
      )}
    </DialogFrame>
  );
}
