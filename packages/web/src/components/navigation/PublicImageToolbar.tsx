import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { GalleryFacetsDto } from "@imageshow/shared/browser";
import { CopyButton } from "../actions/CopyButton.js";
import { FacetSelector } from "../data-display/FacetSelector.js";
import { SelectMenu } from "../form/SelectMenu.js";
import { Icon } from "../icon/Icon.js";
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

export function randomLinkNeedsTruncation(
  contentWidth: number,
  availableWidth: number
) {
  return availableWidth > 0 && contentWidth - availableWidth > 0.5;
}

function RandomLinkText({ value }: { value: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const selectOnClickRef = useRef(false);
  const [truncated, setTruncated] = useState(false);
  const selectLink = () => {
    const content = contentRef.current;
    if (content) content.ownerDocument.getSelection()?.selectAllChildren(content);
  };

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const measure = () => {
      const next = randomLinkNeedsTruncation(
        content.scrollWidth,
        viewport.clientWidth
      );
      setTruncated((current) => current === next ? current : next);
    };
    measure();

    const ownerWindow = viewport.ownerDocument.defaultView;
    const observer = typeof ownerWindow?.ResizeObserver === "function"
      ? new ownerWindow.ResizeObserver(measure)
      : undefined;
    observer?.observe(viewport);
    observer?.observe(content);
    ownerWindow?.addEventListener("resize", measure);

    let active = true;
    void viewport.ownerDocument.fonts?.ready.then(() => {
      if (active) measure();
    });
    return () => {
      active = false;
      observer?.disconnect();
      ownerWindow?.removeEventListener("resize", measure);
    };
  }, [value]);

  return (
    <span
      ref={viewportRef}
      className={`generated-link-value${truncated ? " is-truncated" : ""}`}
      title={truncated ? value : undefined}
      tabIndex={0}
      role="textbox"
      aria-label="随机图片链接"
      aria-readonly="true"
      onFocus={selectLink}
      onPointerDown={(event) => {
        selectOnClickRef.current = event.button === 0
          && event.currentTarget.ownerDocument.activeElement !== event.currentTarget;
      }}
      onClick={() => {
        if (!selectOnClickRef.current) return;
        selectOnClickRef.current = false;
        // Reapply after the browser's first-click caret placement. Further
        // clicks while focused keep native partial text selection.
        selectLink();
      }}
      onBlur={() => { selectOnClickRef.current = false; }}
      onPointerCancel={() => { selectOnClickRef.current = false; }}
    >
      <span ref={contentRef} className="generated-link-text">{value}</span>
      {truncated && (
        <span className="generated-link-truncation" aria-hidden="true">...</span>
      )}
    </span>
  );
}

export function PublicImageToolbar({
  animateEntrance,
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
  animateEntrance: boolean;
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
  const entrance = useOneShotAnimation(animateEntrance);
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
      <div className="generated-link-field">
        <span className="generated-link-label">随机API</span>
        <code>
          <RandomLinkText value={randomUrl} />
        </code>
        <CopyButton value={randomUrl} ariaLabel="复制随机图片链接" />
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
          aria-label="图片筛选条件"
          aria-hidden={filterPanelHidden}
          inert={filterPanelHidden}
        >
          <div className="gallery-filter-fields">
            <div className="gallery-axis">
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
            </div>
            <div className="gallery-axis">
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
            </div>
            <div className="gallery-filter-field gallery-theme-filter">
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
