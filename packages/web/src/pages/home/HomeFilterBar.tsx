import type { GalleryStatsDto } from "@imageshow/shared/browser";
import { Link } from "react-router-dom";
import { Icon } from "../../components/icon/Icon.js";
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
  filters,
  stats,
  isPending,
  isError,
  isPlaceholderData,
  onFiltersChange
}: {
  filters: GalleryFilters;
  stats: GalleryStatsDto | undefined;
  isPending: boolean;
  isError: boolean;
  isPlaceholderData: boolean;
  onFiltersChange: (filters: GalleryFilters) => void;
}) {
  const selectedLabels = stats
    ? [
        filters.device ? deviceLabels[filters.device] : "",
        filters.brightness ? brightnessLabels[filters.brightness] : "",
        ...selectedFacetLabels(stats.themes, filters.theme),
        ...selectedFacetLabels(stats.tags, filters.tag),
        ...selectedFacetLabels(stats.authors, filters.author)
      ].filter(Boolean)
    : [];
  const destination = galleryHref(filters);
  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <section
      className="home-filter-bar"
      aria-label="当前画廊筛选"
    >
      <div>
        <span>GALLERY FILTER</span>
        <strong>选择后进入画廊</strong>
        <small>
          {isPending
            ? "正在读取图库目录"
            : isError
              ? "所选组合暂时无法验证"
              : isPlaceholderData
                ? "正在检查所选组合"
                : hasFilters
                  ? `已选择：${selectedLabels.join(" · ")} · 共有 ${countLabel(stats?.matching_images ?? 0)}`
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
