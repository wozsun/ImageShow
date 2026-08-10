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
  BatchEditableImageSnapshot,
  ImageItem,
  PublicImageItem
} from "../../lib/types.js";
import { hasSessionProbeHint } from "../../lib/api/auth-session.js";
import { useGalleryFacets, useSiteConfig } from "../../lib/api/site-data.js";
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

function hasDistinctOriginal(original: string, displayUrl: string) {
  if (!/^https:\/\//i.test(original.trim())) return false;
  try {
    const normalize = (value: string) => {
      const url = new URL(value.trim());
      url.hash = "";
      return url.toString();
    };
    return normalize(original) !== normalize(displayUrl);
  } catch {
    return original.trim() !== displayUrl.trim();
  }
}

type ImageDetailModalProps =
  | {
      item: PublicImageItem;
      onClose: () => void;
      admin?: false;
      detailLoading?: boolean;
      detailError?: string;
      onDetailRetry?: () => void;
      onDeleteCommitted?: (
        imageId: string
      ) => void | Promise<void>;
      onDeleted?: (imageId: string) => void;
      onItemUpdated?: (item: BatchEditableImageSnapshot) => void;
      returnFocusRef?: RefObject<HTMLElement | null>;
    }
  | {
      item: AdminImageDetailItem | ImageItem;
      onClose: () => void;
      admin: true;
      storageLabel?: string;
      onDeleteCommitted?: (
        imageId: string
      ) => void | Promise<void>;
      onDeleted?: (imageId: string) => void;
      onItemUpdated?: (item: BatchEditableImageSnapshot) => void;
      returnFocusRef?: RefObject<HTMLElement | null>;
    };

export function ImageDetailModal(props: ImageDetailModalProps) {
  const { onClose } = props;
  const [editedSnapshot, setEditedSnapshot] =
    useState<BatchEditableImageSnapshot | null>(null);
  const item = editedSnapshot?.id === props.item.id
    ? {
        ...props.item,
        ...editedSnapshot,
        diff_original: hasDistinctOriginal(
          editedSnapshot.original,
          editedSnapshot.object_url
        )
      }
    : props.item;
  const admin = props.admin === true;
  const adminItem = admin
    ? item as AdminImageDetailItem & Partial<ImageItem>
    : null;
  const adminStorageLabel = props.admin
    && adminItem?.storage_slug === props.item.storage_slug
    ? props.storageLabel
    : undefined;
  const showAdminDetails = admin || hasSessionProbeHint();
  const detailLoading = !admin && props.detailLoading === true;
  const detailError = !admin ? props.detailError?.trim() ?? "" : "";
  const onDetailRetry = !admin ? props.onDetailRetry : undefined;
  const exit = useAnimatedClose(onClose);
  const handleItemDeleted = useCallback((imageId: string) => {
    try {
      props.onDeleted?.(imageId);
    } finally {
      exit.requestClose();
    }
  }, [exit.requestClose, props.onDeleted]);
  const handleItemUpdated = useCallback((nextItem: BatchEditableImageSnapshot) => {
    setEditedSnapshot(nextItem);
    props.onItemUpdated?.(nextItem);
  }, [props.onItemUpdated]);
  usePageScrollLock();
  const mobileLayout = useMediaQuery(mobileViewportMediaQuery);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const detailContentRef = useRef<HTMLDivElement | null>(null);
  const titleHeaderRef = useRef<HTMLElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const [nestedDialogOpen, setNestedDialogOpen] = useState(false);
  useDialogFocus({
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    returnFocusRef: props.returnFocusRef,
    onEscape: () => exit.requestClose(),
    paused: nestedDialogOpen
  });
  const { data: siteConfig } = useSiteConfig();
  const { data: facets } = useGalleryFacets();
  const themeNames = useMemo(() => new Map((facets?.themes ?? []).map((option) => [option.slug, displayNameOrSlug(option)])), [facets]);
  const tagNames = useMemo(() => new Map((facets?.tags ?? []).map((option) => [option.slug, displayNameOrSlug(option)])), [facets]);
  const authorMap = useMemo(() => new Map((facets?.authors ?? []).map((option) => [option.slug, option])), [facets]);
  const displayName = (map: Map<string, string>, slug: string) => map.get(slug) || slug;

  const authorSlug = item.author || "";
  const authorOption = authorSlug ? authorMap.get(authorSlug) : undefined;
  const authorLabel = authorOption ? displayNameOrSlug(authorOption) : authorSlug;
  const authorLink = authorOption?.link || "";

  const titleOpensImage = (siteConfig?.image_detail?.title_opens_image ?? true) && Boolean(item.object_url);
  const title = imageDisplayTitle(item);
  const canOpenOriginal = item.diff_original;
  const imageTime = adminItem?.image_time ?? item.image_time;
  const originalStateLabel = canOpenOriginal ? "打开原图" : "当前图片未注册原图";
  const sourceAvailable = Boolean(item.source);
  const sourceStateLabel = detailError ? "详情加载失败" : detailLoading ? "来源加载中" : sourceAvailable ? "打开来源页面" : "暂无来源";
  const originalHref = adminItem?.deleted_at
    ? `/api/admin/images/${encodeURIComponent(item.id)}/original`
    : `/api/images/${encodeURIComponent(item.id)}/original`;
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
        onClick={() => exit.requestClose()}
      >
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
                  {titleOpensImage
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
                <button
                  className="icon close pressable"
                  ref={closeButtonRef}
                  title="关闭"
                  onClick={() => exit.requestClose()}
                >
                  <Icon name="close-line" />
                </button>
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
                <dt>设备</dt><dd>{deviceOptionLabel(item.device)}</dd>
                <dt>亮度</dt><dd>{brightnessOptionLabel(item.brightness)}</dd>
                <dt>主题</dt><dd>{displayName(themeNames, item.theme)}</dd>
                {item.tags.length > 0 && (
                  <>
                    <dt className="image-detail-tags-label">标签</dt>
                    <dd className="image-detail-tags">
                      {item.tags.map((tag) => (
                        <span key={tag} className="tag-chip">{displayName(tagNames, tag)}</span>
                      ))}
                    </dd>
                  </>
                )}
                <dt>尺寸</dt><dd>{formatDimensions(item.width, item.height)}</dd>
                {imageTime && <><dt>图片时间</dt><dd>{formatDate(imageTime)}</dd></>}
              </dl>
              <div className="inline-actions image-detail-actions" ref={actionsRef}>
                <a
                  className={`button pressable image-detail-original${canOpenOriginal ? "" : " is-disabled"}`}
                  href={canOpenOriginal ? originalHref : undefined}
                  target="_blank"
                  rel="noreferrer noopener"
                  referrerPolicy="no-referrer"
                  aria-disabled={!canOpenOriginal}
                  aria-label={originalStateLabel}
                  title={originalStateLabel}
                  tabIndex={canOpenOriginal ? undefined : -1}
                  onClick={(event) => { if (!canOpenOriginal) event.preventDefault(); }}
                >
                  原图
                </a>
                <a
                  className={`button secondary pressable image-detail-source${sourceAvailable ? "" : " is-disabled"}`}
                  href={sourceAvailable ? item.source : undefined}
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
                      onItemDeleteCommitted={props.onDeleteCommitted}
                      onItemDeleted={handleItemDeleted}
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
