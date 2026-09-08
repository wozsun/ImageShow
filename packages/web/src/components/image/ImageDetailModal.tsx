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
import { displayNameOrSlug, imageDisplayTitle, formatDate, formatDimensions } from "../../lib/ui/formatters.js";
import { brightnessOptionLabel, deviceOptionLabel } from "../../lib/ui/select-options.js";
import type {
  AdminImageDetailItem,
  EditableImageSnapshot,
  AdminImageListItem,
  ImageDetailItem,
  PublicImageItem
} from "../../lib/types.js";
import { useGalleryFacets, useSiteConfig } from "../../lib/api/site-data.js";
import {
  createGalleryTaxonomyDisplayFormatter
} from "../../lib/gallery/card-display.js";
import { useAuthMe } from "../../hooks/useAuthSession.js";
import { useAnimatedClose } from "../../hooks/useAnimatedClose.js";
import { usePageScrollLock } from "../../hooks/usePageScrollLock.js";
import { useDialogFocus } from "../../hooks/useDialogFocus.js";
import {
  mobileViewportMediaQuery,
  useMediaQuery
} from "../../hooks/useMediaQuery.js";
import { OverlayScrollbar } from "../layout/OverlayScrollbar.js";
import { ImageDescriptionSlot } from "./ImageDescriptionSlot.js";
import { DialogLayerPortal } from "../feedback/DialogLayerPortal.js";
import { DialogPortalTargetContext } from "../feedback/DialogPortalContext.js";
import { DirectActivationButton } from "../feedback/DirectActivationButton.js";
import { LazyImageAdminDetails } from "./image-admin-details-loader.js";
import "../../styles/image-detail.css";

class ImageAdminDetailsModuleBoundary extends Component<{
  children: ReactNode;
  resetKey: string;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previousProps: Readonly<{
    children: ReactNode;
    resetKey: string;
  }>) {
    if (
      this.state.failed
      && previousProps.resetKey !== this.props.resetKey
    ) {
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

function applyEditedSnapshot<T extends ImageDetailItem>(
  item: T,
  snapshot: EditableImageSnapshot | null
): T {
  if (snapshot?.id !== item.id) return item;
  return {
    ...item,
    ...snapshot
  } as T;
}

type ImageDetailModalProps =
  | {
    item: PublicImageItem;
    onClose: () => void;
    admin?: false;
    detailLoading?: boolean;
    detailError?: string;
    onDetailRetry?: () => void;
    onTrashCommitted?: (
      imageId: string
    ) => void | Promise<void>;
    onTrashed?: (imageId: string) => void;
    onItemUpdated?: (item: EditableImageSnapshot) => void;
    onItemRefreshRequested?: (imageId: string) => void;
    returnFocusRef?: RefObject<HTMLElement | null>;
  }
  | {
    item: AdminImageDetailItem | AdminImageListItem;
    onClose: () => void;
    admin: true;
    storageLabel: string;
    onTrashCommitted?: (
      imageId: string
    ) => void | Promise<void>;
    onTrashed?: (imageId: string) => void;
    onItemUpdated?: (item: EditableImageSnapshot) => void;
    onItemRefreshRequested?: (imageId: string) => void;
    returnFocusRef?: RefObject<HTMLElement | null>;
  };

export function ImageDetailModal(props: ImageDetailModalProps) {
  const { onClose } = props;
  const [editedSnapshot, setEditedSnapshot] =
    useState<EditableImageSnapshot | null>(null);
  const item = applyEditedSnapshot(props.item, editedSnapshot);
  const admin = props.admin === true;
  const adminItem = props.admin === true
    ? applyEditedSnapshot(props.item, editedSnapshot)
    : null;
  const adminStorageLabel = props.admin ? props.storageLabel : undefined;
  const authQuery = useAuthMe();
  const showAdminDetails = admin
    || authQuery.data?.authenticated === true;
  const detailLoading = !editedSnapshot && !admin && props.detailLoading === true;
  const detailError = !editedSnapshot && !admin ? props.detailError?.trim() ?? "" : "";
  const onDetailRetry = !admin ? props.onDetailRetry : undefined;
  const exit = useAnimatedClose(onClose);
  const handleItemTrashed = useCallback((imageId: string) => {
    try {
      props.onTrashed?.(imageId);
    } finally {
      exit.requestClose();
    }
  }, [exit.requestClose, props.onTrashed]);
  const handleItemUpdated = useCallback((nextItem: EditableImageSnapshot) => {
    setEditedSnapshot(nextItem);
    props.onItemUpdated?.(nextItem);
  }, [props.onItemUpdated]);
  const handleItemRefreshRequested = useCallback((imageId: string) => {
    setEditedSnapshot((current) => current?.id === imageId ? null : current);
    props.onItemRefreshRequested?.(imageId);
  }, [props.onItemRefreshRequested]);
  usePageScrollLock();
  const mobileLayout = useMediaQuery(mobileViewportMediaQuery);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const desktopCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const mobileCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const detailContentRef = useRef<HTMLDivElement | null>(null);
  const titleHeaderRef = useRef<HTMLElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const [nestedDialogOpen, setNestedDialogOpen] = useState(false);
  useDialogFocus({
    containerRef: frameRef,
    initialFocusRef: mobileLayout
      ? mobileCloseButtonRef
      : desktopCloseButtonRef,
    returnFocusRef: props.returnFocusRef,
    onEscape: () => exit.requestClose(),
    paused: nestedDialogOpen
  });
  const { data: siteConfig } = useSiteConfig();
  const { data: facets } = useGalleryFacets();
  const taxonomyDisplay = useMemo(
    () => createGalleryTaxonomyDisplayFormatter(facets),
    [facets]
  );
  const authorMap = useMemo(() => new Map((facets?.authors ?? []).map((option) => [option.slug, option])), [facets]);

  const { themeLabel, tagLabels } = taxonomyDisplay(item);

  const authorSlug = item.author || "";
  const authorOption = authorSlug ? authorMap.get(authorSlug) : undefined;
  const authorLabel = authorOption ? displayNameOrSlug(authorOption) : authorSlug;
  const authorLink = authorOption?.link || "";

  const title = imageDisplayTitle(item);
  const imageTime = adminItem?.image_time ?? item.image_time;
  const sourceAvailable = Boolean(item.source);
  const sourceStateLabel = detailError ? "详情加载失败" : detailLoading ? "来源加载中" : sourceAvailable ? "打开来源页面" : "暂无来源";
  const originalHref = item.original_url?.trim() ?? "";
  const showOriginalAction = showAdminDetails
    || siteConfig?.site.gallery.public_original_button === true;
  const imageAspectRatio = item.width > 0 && item.height > 0
    ? `${item.width} / ${item.height}`
    : "16 / 9";

  return (
    <DialogLayerPortal>
      <div
        ref={frameRef}
        className={`modal image-detail-modal ${exit.closing ? "is-closing" : ""}`}
        data-dialog-frame=""
        data-admin-dialog={admin ? "" : undefined}
        role="dialog"
        aria-modal="true"
        aria-label="图片详情"
        onAnimationEnd={exit.onAnimationEnd}
        onClick={(event) => {
          if (event.target === event.currentTarget) exit.requestClose();
        }}
      >
        {mobileLayout && (
          <DirectActivationButton
            ref={mobileCloseButtonRef}
            className="icon close pressable image-detail-mobile-close"
            type="button"
            title="关闭"
            aria-label="关闭图片详情"
            onActivate={() => exit.requestClose()}
          >
            <Icon name="close-line" />
          </DirectActivationButton>
        )}
        <DialogPortalTargetContext.Provider value={frameRef}>
          <article ref={dialogRef} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
            <ProgressiveImage
              key={item.id}
              imageKey={item.id}
              thumbSrc={item.thumb_url}
              fullSrc={item.object_url}
              alt={title}
              className="image-detail-image"
              style={{ aspectRatio: imageAspectRatio }}
            />
            <div className="image-detail-panel">
              <div className="image-detail-content" ref={detailContentRef}>
                <header className="image-detail-head" ref={titleHeaderRef}>
                  <div className="image-detail-title-row">
                    <h2>
                      {item.object_url.trim()
                        ? (
                          <a
                            className="image-detail-title-link"
                            href={item.object_url}
                            target="_blank"
                            rel="noreferrer noopener"
                            referrerPolicy="no-referrer"
                            title="在新标签页打开图片直链"
                          >
                            {title}
                          </a>
                        )
                        : title}
                    </h2>
                    {!mobileLayout && (
                      <button
                        className="icon close pressable"
                        ref={desktopCloseButtonRef}
                        type="button"
                        title="关闭"
                        aria-label="关闭图片详情"
                        onClick={() => exit.requestClose()}
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
                          {authorLink
                            ? (
                              <a
                                href={authorLink}
                                target="_blank"
                                rel="noreferrer noopener"
                                referrerPolicy="no-referrer"
                              >
                                {authorLabel}
                              </a>
                            )
                            : authorLabel}
                        </dd>
                      </>
                    )}
                    <dt>设备</dt><dd>{detailLoading ? "加载中" : detailError ? "加载失败" : deviceOptionLabel(item.device)}</dd>
                    <dt>亮度</dt><dd>{detailLoading ? "加载中" : detailError ? "加载失败" : brightnessOptionLabel(item.brightness)}</dd>
                    <dt>主题</dt><dd>{detailLoading ? "加载中" : detailError ? "加载失败" : themeLabel}</dd>
                    {item.tags.length > 0 && (
                      <>
                        <dt className="image-detail-tags-label">标签</dt>
                        <dd className="image-detail-tags">
                          {item.tags.map((tag, index) => (
                            <span key={tag} className="tag-chip">{tagLabels[index]}</span>
                          ))}
                        </dd>
                      </>
                    )}
                    <dt>尺寸</dt><dd>{formatDimensions(item.width, item.height)}</dd>
                    {imageTime && <><dt>图片时间</dt><dd>{formatDate(imageTime)}</dd></>}
                  </dl>
                  <div className="inline-actions image-detail-actions" ref={actionsRef}>
                    <a
                      className={`button secondary pressable image-detail-source${sourceAvailable ? "" : " is-disabled"}`}
                      href={item.source || undefined}
                      target="_blank"
                      rel="noreferrer noopener"
                      referrerPolicy="no-referrer"
                      aria-disabled={!sourceAvailable}
                      aria-label={sourceStateLabel}
                      title={sourceStateLabel}
                      tabIndex={sourceAvailable ? undefined : -1}
                      onClick={(event) => { if (!sourceAvailable) event.preventDefault(); }}
                    >
                      <Icon name="external-link-line" />来源
                    </a>
                    {showOriginalAction && originalHref && (
                      <a
                        className="button pressable image-detail-original"
                        href={originalHref}
                        target="_blank"
                        rel="noreferrer noopener"
                        referrerPolicy="no-referrer"
                        aria-label="打开原图"
                        title="打开原图"
                      >
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
                          adminStorageLabel={adminStorageLabel}
                          onItemUpdated={handleItemUpdated}
                          onItemRefreshRequested={handleItemRefreshRequested}
                          onItemTrashCommitted={props.onTrashCommitted}
                          onItemTrashed={handleItemTrashed}
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
        </DialogPortalTargetContext.Provider>
      </div>
    </DialogLayerPortal>
  );
}
