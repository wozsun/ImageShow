import type { RefObject } from "react";
import type { GalleryFacetsDto } from "@imageshow/shared/browser";
import { CopyButton } from "../../components/actions/CopyButton.js";
import { FacetSelector } from "../../components/data-display/FacetSelector.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import { Icon } from "../../components/icon/Icon.js";
import { AnchoredMenuDismissSignalContext } from "../../hooks/useAnchoredMenu.js";
import {
  mobileViewportMediaQuery,
  useMediaQuery
} from "../../hooks/useMediaQuery.js";
import { useOneShotAnimation } from "../../hooks/useOneShotAnimation.js";
import type { GalleryFilters } from "../../lib/gallery/gallery-query.js";
import {
  brightnessOptionLabel,
  deviceOptionLabel
} from "../../lib/ui/select-options.js";

export function GalleryToolbar({
  filters,
  facets,
  randomUrl,
  filtersOpen,
  filterPanelHidden,
  filterMenuDismissSignal,
  toolbarVisible,
  toolbarRef,
  filterToggleRef,
  clearFiltersRef,
  filterPanelRef,
  toggleFilters,
  dismissFilterMenus,
  onFilterChange,
  onClearFilters
}: {
  filters: GalleryFilters;
  facets: GalleryFacetsDto | undefined;
  randomUrl: string;
  filtersOpen: boolean;
  filterPanelHidden: boolean | undefined;
  filterMenuDismissSignal: number;
  toolbarVisible: boolean;
  toolbarRef: RefObject<HTMLElement | null>;
  filterToggleRef: RefObject<HTMLButtonElement | null>;
  clearFiltersRef: RefObject<HTMLButtonElement | null>;
  filterPanelRef: RefObject<HTMLDivElement | null>;
  toggleFilters: () => void;
  dismissFilterMenus: () => void;
  onFilterChange: (key: keyof GalleryFilters, value: string) => void;
  onClearFilters: () => void;
}) {
  const entrance = useOneShotAnimation(true);
  const mobileLayout = useMediaQuery(mobileViewportMediaQuery);
  const actionFollowsFilters = useMediaQuery("(min-width: 1000px)");
  const activeFilterCount = [
    filters.device,
    filters.brightness,
    filters.theme,
    filters.tag,
    filters.author
  ].filter(Boolean).length;
  const clearDisabled = activeFilterCount === 0;
  const clearFilters = () => {
    dismissFilterMenus();
    onClearFilters();
  };
  const desktopClearAction = (
    <div className="gallery-filter-action">
      <span>操作</span>
      <button
        ref={!mobileLayout ? clearFiltersRef : undefined}
        type="button"
        className="gallery-filter-clear pressable"
        disabled={clearDisabled}
        onClick={clearFilters}
      >
        清空筛选
      </button>
    </div>
  );
  const randomLink = (
    <div className="theme-link">
      <span>随机图片API</span>
      <div className="theme-link-row">
        <div className="generated-link-field">
          <code>
            <span>{randomUrl}</span>
          </code>
          <CopyButton value={randomUrl} ariaLabel="复制随机图片链接" />
        </div>
      </div>
    </div>
  );

  return (
    <section
      ref={toolbarRef}
      className={`gallery-toolbar public-navigation-secondary${entrance.active ? " is-gallery-toolbar-entrance" : ""}${filtersOpen ? " filters-open" : ""}${toolbarVisible ? "" : " is-scroll-hidden"}`}
      inert={!toolbarVisible}
      onAnimationEnd={(event) => {
        if (
          event.currentTarget === event.target
          && event.animationName === "gallery-toolbar-entrance"
        ) {
          entrance.finish();
        }
      }}
    >
      <div className="gallery-filter-actions">
        <button
          ref={filterToggleRef}
          type="button"
          className="gallery-filter-toggle pressable"
          aria-expanded={filtersOpen}
          aria-controls="gallery-filter-panel"
          onClick={toggleFilters}
        >
          <Icon name="filter-3-line" />
          筛选
          {activeFilterCount > 0 && (
            <span className="gallery-filter-count">{activeFilterCount}</span>
          )}
          <span className="gallery-filter-chevron">
            <Icon name="arrow-down-s-line" />
          </span>
        </button>
        {mobileLayout && (
          <>
            <span className="gallery-filter-action-divider" aria-hidden="true" />
            <button
              ref={clearFiltersRef}
              type="button"
              className="gallery-filter-clear gallery-filter-clear-mobile pressable"
              disabled={clearDisabled}
              onClick={clearFilters}
            >
              清空
            </button>
          </>
        )}
      </div>
      <AnchoredMenuDismissSignalContext.Provider value={filterMenuDismissSignal}>
        <div
          ref={filterPanelRef}
          id="gallery-filter-panel"
          className="gallery-filter-panel"
          role="group"
          aria-label="画廊筛选条件"
          aria-hidden={filterPanelHidden}
          inert={filterPanelHidden}
        >
          <div className="gallery-filter-fields">
            <label className="gallery-axis">
              设备
              <SelectMenu
                value={filters.device}
                onChange={(value) => onFilterChange("device", value)}
                options={[
                  { value: "", label: "全部设备" },
                  { value: "auto", label: "自动设备" },
                  ...(facets?.devices ?? ["pc", "mb"]).map((value) => ({
                    value,
                    label: deviceOptionLabel(value)
                  }))
                ]}
                ariaLabel="设备"
                menuClassName="public-gallery-menu"
              />
            </label>
            <label className="gallery-axis">
              亮度
              <SelectMenu
                value={filters.brightness}
                onChange={(value) => onFilterChange("brightness", value)}
                options={[
                  { value: "", label: "全部亮度" },
                  ...(facets?.brightnesses ?? ["light", "dark"]).map((value) => ({
                    value,
                    label: brightnessOptionLabel(value)
                  }))
                ]}
                ariaLabel="亮度"
                menuClassName="public-gallery-menu"
              />
            </label>
            <div className="gallery-filter-field gallery-theme-filter">
              <label htmlFor="gallery-theme-facet">主题</label>
              <FacetSelector
                options={facets?.themes ?? []}
                value={filters.theme}
                onChange={(value) => onFilterChange("theme", value)}
                noun="主题"
                ariaLabel="主题"
                controlId="gallery-theme-facet"
                menuClassName="public-gallery-menu"
              />
            </div>
            <div className="gallery-filter-field gallery-tag-filter">
              <label htmlFor="gallery-tag-facet">标签</label>
              <FacetSelector
                options={facets?.tags ?? []}
                value={filters.tag}
                onChange={(value) => onFilterChange("tag", value)}
                noun="标签"
                ariaLabel="标签"
                controlId="gallery-tag-facet"
                menuClassName="public-gallery-menu"
              />
            </div>
            <div className="gallery-filter-field gallery-author-filter">
              <label htmlFor="gallery-author-facet">作者</label>
              <FacetSelector
                options={facets?.authors ?? []}
                value={filters.author}
                onChange={(value) => onFilterChange("author", value)}
                noun="作者"
                ariaLabel="作者"
                controlId="gallery-author-facet"
                menuClassName="public-gallery-menu"
              />
            </div>
          </div>
          {!mobileLayout && actionFollowsFilters && desktopClearAction}
          {randomLink}
          {!mobileLayout && !actionFollowsFilters && desktopClearAction}
        </div>
      </AnchoredMenuDismissSignalContext.Provider>
    </section>
  );
}
