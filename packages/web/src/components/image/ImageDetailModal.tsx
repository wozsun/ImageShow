import { lazy, Suspense, useMemo, useRef, type RefObject } from "react";
import { Icon } from "../icon/Icon.js";
import { ProgressiveImage } from "./ProgressiveImage.js";
import { displayNameOrSlug, imageDisplayTitle, formatDate, formatDimensions } from "../../lib/ui/formatters.js";
import { brightnessOptionLabel, deviceOptionLabel } from "../../lib/ui/select-options.js";
import type { ImageItem, PublicImageItem } from "../../lib/types.js";
import { hasSessionProbeHint, useGalleryFacets, useSiteConfig } from "../../lib/api/site-data.js";
import { useAnimatedClose } from "../../hooks/useAnimatedClose.js";
import { useBodyScrollLock } from "../../hooks/useBodyScrollLock.js";
import { useDialogFocus } from "../../hooks/useDialogFocus.js";
import { OverlayScrollbar } from "../layout/OverlayScrollbar.js";
import { ImageDescriptionSlot } from "./ImageDescriptionSlot.js";

const ImageAdminDetails = lazy(() => import("./ImageAdminDetails.js").then((module) => ({
  default: module.ImageAdminDetails
})));

type ImageDetailModalProps =
  | {
      item: PublicImageItem;
      onClose: () => void;
      admin?: false;
      detailLoading?: boolean;
      detailError?: string;
      onDetailRetry?: () => void;
      returnFocusRef?: RefObject<HTMLElement | null>;
    }
  | {
      item: ImageItem;
      onClose: () => void;
      admin: true;
      returnFocusRef?: RefObject<HTMLElement | null>;
    };

export function ImageDetailModal(props: ImageDetailModalProps) {
  const { item, onClose } = props;
  const admin = props.admin === true;
  const adminItem = admin ? props.item : null;
  const showAdminDetails = admin || hasSessionProbeHint();
  const detailLoading = !admin && props.detailLoading === true;
  const detailError = !admin ? props.detailError?.trim() ?? "" : "";
  const onDetailRetry = !admin ? props.onDetailRetry : undefined;
  const exit = useAnimatedClose(onClose);
  useBodyScrollLock();
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const detailContentRef = useRef<HTMLDivElement | null>(null);
  const titleHeaderRef = useRef<HTMLElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  useDialogFocus({
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    returnFocusRef: props.returnFocusRef,
    onEscape: () => exit.requestClose(),
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

  return (
    <div
      className={`modal image-detail-modal ${exit.closing ? "is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="图片详情"
      onAnimationEnd={exit.onAnimationEnd}
      onClick={() => exit.requestClose()}
    >
      <article ref={dialogRef} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <ProgressiveImage
          key={item.id}
          imageKey={item.id}
          thumbSrc={item.thumb_url}
          fullSrc={item.object_url}
          alt={title}
          className="image-detail-image"
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
                <Suspense fallback={null}>
                  <ImageAdminDetails
                    key={item.id}
                    imageId={item.id}
                    adminItem={adminItem}
                  />
                </Suspense>
              )}
            </div>
          </div>
          <OverlayScrollbar
            targetRef={detailContentRef}
            topInsetRef={titleHeaderRef}
            enableOnTouch
          />
        </div>
      </article>
    </div>
  );
}
