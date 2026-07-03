import { useMemo, useRef } from "react";
import { Icon } from "../icon/Icon.js";
import { formatDate, formatDimensions, formatIndex } from "../../lib/ui/formatters.js";
import { brightnessOptionLabel, deviceOptionLabel } from "../../lib/ui/select-options.js";
import type { ImageItem } from "../../lib/types.js";
import { useGalleryOptions, useSiteConfig } from "../../lib/api/site-data.js";
import { useStorageNameResolver } from "../../lib/api/storage-options.js";
import { useAnimatedClose } from "../../hooks/useAnimatedClose.js";
import { useBodyScrollLock } from "../../hooks/useBodyScrollLock.js";
import { OverlayScrollbar } from "../layout/OverlayScrollbar.js";

export function ImageDetailModal({ item, onClose, admin = false }: { item: ImageItem; onClose: () => void; admin?: boolean }) {
  const exit = useAnimatedClose(onClose);
  useBodyScrollLock();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const { data: siteConfig } = useSiteConfig();

  const { data: facets } = useGalleryOptions();
  // 存储行仅在 admin 详情展示，故仅在 admin 时拉取后端列表来把 slug 解析成显示名。
  const storageName = useStorageNameResolver(admin);
  const themeNames = useMemo(() => new Map((facets?.themes ?? []).map((option) => [option.slug, option.display_name])), [facets]);
  const tagNames = useMemo(() => new Map((facets?.tags ?? []).map((option) => [option.slug, option.display_name])), [facets]);
  const authorMap = useMemo(() => new Map((facets?.authors ?? []).map((option) => [option.slug, option])), [facets]);
  const displayName = (map: Map<string, string>, slug: string) => map.get(slug) || slug;

  const authorSlug = item.author || "";
  const authorOption = authorSlug ? authorMap.get(authorSlug) : undefined;
  const authorLabel = authorOption?.display_name || authorSlug;
  const authorLink = authorOption?.link || "";

  const titleOpensImage = (siteConfig?.image_detail?.title_opens_image ?? true) && Boolean(item.object_url);
  const title = item.title || item.index_key;

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
        <img src={item.object_url} alt={item.title || "图片详情"} referrerPolicy="no-referrer" />
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
            {admin && (
              <>
                <dt>UUID</dt><dd>{item.id}</dd>
                <dt>MD5</dt><dd>{item.md5 || "未记录"}</dd>
                <dt>存储</dt><dd>{storageName(item)}</dd>
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
            {admin && item.tags.length > 0 && (
              <>
                <dt>标签</dt>
                <dd className="image-detail-tags">
                  {item.tags.map((tag) => (
                    <span key={tag} className="tag-chip">{displayName(tagNames, tag)}</span>
                  ))}
                </dd>
              </>
            )}
            <dt>序号</dt><dd>{formatIndex(item)}</dd>
            <dt>尺寸</dt><dd>{formatDimensions(item.width, item.height)}</dd>
            {admin && <><dt>创建</dt><dd>{formatDate(item.created_at)}</dd></>}
            {admin && item.deleted_at && <><dt>删除</dt><dd>{formatDate(item.deleted_at)}</dd></>}
          </dl>
          <div className="inline-actions">
            {item.original && (
              <a
                className="button pressable"
                href={admin
                  ? `/api/admin/images/${encodeURIComponent(item.id)}/original`
                  : `/api/images/${encodeURIComponent(item.id)}/original`}
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
