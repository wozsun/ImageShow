import type { GalleryStatsDto } from "@imageshow/shared/browser";
import { Link } from "react-router";
import { Icon } from "../../components/icon/Icon.js";
import { useOneShotAnimation } from "../../hooks/useOneShotAnimation.js";
import {
  emptyGalleryFilters,
  galleryHref,
  type GalleryFilters
} from "../../lib/gallery/gallery-query.js";
import {
  brightnessLabels,
  countLabel,
  deviceLabels,
  selectedFacetLabels
} from "./home-ui.js";
import {
  usePublicRoutePreloadIntents
} from "../../lib/public-route-modules.js";

export function HomeFilterBar({
  entranceReady,
  filters,
  stats,
  isPending,
  isError,
  isPlaceholderData,
  browsePath,
  onFiltersChange
}: {
  entranceReady: boolean;
  filters: GalleryFilters;
  stats: GalleryStatsDto | undefined;
  isPending: boolean;
  isError: boolean;
  isPlaceholderData: boolean;
  browsePath: "/show" | "/gallery" | "/embed/show" | "/embed/gallery" | null;
  onFiltersChange: (filters: GalleryFilters) => void;
}) {
  const entrance = useOneShotAnimation(entranceReady);
  const selectedLabels = stats
    ? [
        filters.device ? deviceLabels[filters.device] : "",
        filters.brightness
          ? brightnessLabels[filters.brightness]
          : "",
        selectedFacetLabels(stats.themes, filters.theme).join("/"),
        selectedFacetLabels(stats.tags, filters.tag).join("/"),
        selectedFacetLabels(stats.authors, filters.author).join("/")
      ].filter(Boolean)
    : [];
  const destination = browsePath ? galleryHref(filters, browsePath) : null;
  const targetIsShow = browsePath === "/show" || browsePath === "/embed/show";
  const targetLabel = targetIsShow
    ? "展映"
    : browsePath
      ? "画廊"
      : "展示页";
  const hasFilters = Object.values(filters).some(Boolean);
  const publicRoutePreloadIntents = usePublicRoutePreloadIntents();
  const targetPreloadProps = targetIsShow
    ? publicRoutePreloadIntents.show
    : browsePath === "/gallery" || browsePath === "/embed/gallery"
      ? publicRoutePreloadIntents.gallery
      : {};

  return (
    <section
      className={`home-filter-bar public-navigation-secondary${entrance.active ? " is-home-filter-bar-entrance" : ""}`}
      aria-label={`当前${targetLabel}筛选`}
      aria-busy={isPending || isPlaceholderData}
      onAnimationEnd={(event) => {
        if (
          event.currentTarget === event.target
          && event.animationName === "home-filter-bar-surface-reveal"
        ) {
          entrance.finish();
        }
      }}
    >
      <div>
        <span>IMAGE FILTER</span>
        <strong>{browsePath
          ? `选择后进入${targetLabel}`
          : "暂无可用展示页"}</strong>
        <small>
          {!browsePath
            ? "画廊与展映均已关闭，可继续预选筛选条件"
            : isPending
            ? "正在读取图库目录"
            : isError
              ? "所选组合暂时无法验证"
              : hasFilters
                ? `已选择：${selectedLabels.join(" · ")} · ${
                    isPlaceholderData
                      ? "正在检查"
                      : `共有 ${countLabel(stats?.matching_images ?? 0)}`
                  }`
                : `未设置筛选条件，将在${targetLabel}浏览全部图片`}
        </small>
      </div>
      <button
        type="button"
        className="home-filter-reset"
        aria-label="重置筛选"
        disabled={!hasFilters}
        onClick={() => onFiltersChange({ ...emptyGalleryFilters })}
      >
        <span className="home-filter-reset-icon" aria-hidden="true">
          <Icon name="refresh-line" />
        </span>
        <span className="home-filter-reset-label">重置</span>
      </button>
      {destination
        ? (
            <Link
              className="home-gallery-entry"
              to={destination}
              {...targetPreloadProps}
            >
              {`进入${targetLabel}`} <span aria-hidden="true">→</span>
            </Link>
          )
        : (
            <span
              className="home-gallery-entry is-disabled"
              aria-disabled="true"
            >
              暂无可用展示页
            </span>
          )}
    </section>
  );
}
