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

export function HomeFilterBar({
  entranceReady,
  filters,
  stats,
  isPending,
  isError,
  isPlaceholderData,
  galleryPath = "/gallery",
  onFiltersChange
}: {
  entranceReady: boolean;
  filters: GalleryFilters;
  stats: GalleryStatsDto | undefined;
  isPending: boolean;
  isError: boolean;
  isPlaceholderData: boolean;
  galleryPath?: "/gallery" | "/embed/gallery";
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
  const destination = galleryHref(filters, galleryPath);
  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <section
      className={`home-filter-bar public-navigation-secondary${entrance.active ? " is-home-filter-bar-entrance" : ""}`}
      aria-label="当前画廊筛选"
      aria-busy={isPending || isPlaceholderData}
      onAnimationEnd={(event) => {
        if (
          event.currentTarget === event.target
          && event.animationName === "home-filter-bar-fade-in"
        ) {
          entrance.finish();
        }
      }}
    >
      <div>
        <span>GALLERY FILTER</span>
        <strong>选择后进入画廊</strong>
        <small>
          {isPending
            ? "正在读取图库目录"
            : isError
              ? "所选组合暂时无法验证"
              : hasFilters
                ? `已选择：${selectedLabels.join(" · ")} · ${
                    isPlaceholderData
                      ? "正在检查"
                      : `共有 ${countLabel(stats?.matching_images ?? 0)}`
                  }`
                : "未设置筛选条件，将浏览全部图片"}
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
      <Link className="home-gallery-entry" to={destination}>
        进入画廊 <span aria-hidden="true">→</span>
      </Link>
    </section>
  );
}
