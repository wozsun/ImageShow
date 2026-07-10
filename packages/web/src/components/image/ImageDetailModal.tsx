import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, isApiClientError } from "../../lib/api/client.js";
import { Icon } from "../icon/Icon.js";
import { ProgressiveImage } from "./ProgressiveImage.js";
import { displayNameOrSlug, imageDisplayTitle, formatDate, formatDimensions } from "../../lib/ui/formatters.js";
import { brightnessOptionLabel, deviceOptionLabel } from "../../lib/ui/select-options.js";
import type { ImageAdminInfo, ImageItem, PublicImageItem } from "../../lib/types.js";
import { clearSessionProbeHint, hasSessionProbeHint, useGalleryFacets, useSiteConfig } from "../../lib/api/site-data.js";
import { useStorageNameResolver } from "../../lib/api/storage-options.js";
import { adminApiBasePath, queryKeys } from "../../lib/constants.js";
import { useAnimatedClose } from "../../hooks/useAnimatedClose.js";
import { useBodyScrollLock } from "../../hooks/useBodyScrollLock.js";
import { OverlayScrollbar } from "../layout/OverlayScrollbar.js";

type ImageDetailModalProps =
  | { item: PublicImageItem; onClose: () => void; admin?: false }
  | { item: ImageItem; onClose: () => void; admin: true };

export function ImageDetailModal(props: ImageDetailModalProps) {
  const { item, onClose } = props;
  const admin = props.admin === true;
  const adminItem = admin ? props.item : null;
  const shouldProbeAdminSession = !admin && hasSessionProbeHint();
  const exit = useAnimatedClose(onClose);
  useBodyScrollLock();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const { data: siteConfig } = useSiteConfig();
  const { data: rawAdminInfo, error: adminInfoError } = useQuery<ImageAdminInfo>({
    queryKey: [...queryKeys.adminImageInfo, item.id],
    queryFn: ({ signal }) => api(`${adminApiBasePath}/images/${encodeURIComponent(item.id)}/admin-info`, { signal }),
    enabled: shouldProbeAdminSession,
    retry: false,
    refetchOnWindowFocus: false
  });

  const { data: facets } = useGalleryFacets();
  // 后台完整详情只有 storage_slug，需拉取后端列表来解析显示名；登录态公开详情由 admin-info 直接返回标签。
  const storageName = useStorageNameResolver(admin);
  const themeNames = useMemo(() => new Map((facets?.themes ?? []).map((option) => [option.slug, displayNameOrSlug(option)])), [facets]);
  const tagNames = useMemo(() => new Map((facets?.tags ?? []).map((option) => [option.slug, displayNameOrSlug(option)])), [facets]);
  const authorMap = useMemo(() => new Map((facets?.authors ?? []).map((option) => [option.slug, option])), [facets]);
  const displayName = (map: Map<string, string>, slug: string) => map.get(slug) || slug;

  const authorSlug = item.author || "";
  const authorOption = authorSlug ? authorMap.get(authorSlug) : undefined;
  const authorLabel = authorOption ? displayNameOrSlug(authorOption) : authorSlug;
  const authorLink = authorOption?.link || "";

  const adminInfo = rawAdminInfo?.id === item.id ? rawAdminInfo : undefined;
  const titleOpensImage = (siteConfig?.image_detail?.title_opens_image ?? true) && Boolean(item.object_url);
  const title = imageDisplayTitle(item);
  const canOpenOriginal = item.has_distinct_original;
  const imageTime = adminItem?.image_time ?? adminInfo?.image_time ?? item.image_time;
  const createdAt = adminItem?.created_at ?? adminInfo?.created_at;
  const updatedAt = adminItem?.updated_at ?? adminInfo?.updated_at;
  const originalHref = adminItem?.deleted_at
    ? `/api/admin/images/${encodeURIComponent(item.id)}/original`
    : `/api/images/${encodeURIComponent(item.id)}/original`;

  useEffect(() => {
    if (!admin && isApiClientError(adminInfoError) && adminInfoError.status === 401) clearSessionProbeHint();
  }, [admin, adminInfoError]);

  return (
    <div
      className={`modal image-detail-modal ${exit.closing ? "is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="图片详情"
      onAnimationEnd={exit.onAnimationEnd}
      onClick={() => exit.requestClose()}
    >
      <article onClick={(event) => event.stopPropagation()}>
        <ProgressiveImage
          key={item.id}
          imageKey={item.id}
          thumbSrc={item.thumb_url}
          fullSrc={item.object_url}
          alt={title}
          className="image-detail-image"
        />
        <div className="image-detail-content" ref={contentRef}>
          <header className="image-detail-head">
            <div>
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
              <p>{item.description}</p>
            </div>
            <button className="icon close pressable" title="关闭" onClick={() => exit.requestClose()}>
              <Icon name="close-line" />
            </button>
          </header>
          <dl>
            {(admin || adminInfo) && <><dt>UUID</dt><dd>{item.id}</dd></>}
            {admin && (
              <>
                <dt>MD5</dt><dd>{adminItem?.md5 || "未记录"}</dd>
                {adminItem && <><dt>存储</dt><dd>{storageName(adminItem)}</dd></>}
              </>
            )}
            {!admin && adminInfo && (
              <>
                <dt>MD5</dt><dd>{adminInfo.md5 || "未记录"}</dd>
                <dt>存储</dt><dd>{adminInfo.storage_label || "未记录"}</dd>
              </>
            )}
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
            {(admin || adminInfo) && createdAt && <><dt>导入时间</dt><dd>{formatDate(createdAt)}</dd></>}
            {(admin || adminInfo) && updatedAt && <><dt>更新时间</dt><dd>{formatDate(updatedAt)}</dd></>}
            {adminItem?.deleted_at && <><dt>删除</dt><dd>{formatDate(adminItem.deleted_at)}</dd></>}
          </dl>
          <div className="inline-actions">
            {canOpenOriginal && (
              <a
                className="button pressable"
                href={originalHref}
                target="_blank"
                rel="noreferrer noopener"
                referrerPolicy="no-referrer"
              >
                原图
              </a>
            )}
            {item.source && (
              <a
                className="button secondary pressable"
                href={item.source}
                target="_blank"
                rel="noreferrer noopener"
                referrerPolicy="no-referrer"
              >
                <Icon name="external-link-line" />来源
              </a>
            )}
          </div>
        </div>
        <OverlayScrollbar targetRef={contentRef} />
      </article>
    </div>
  );
}
