import type { useImageBrowseRoute } from "../../hooks/useImageBrowseRoute.js";
import type { usePublicImageViewportControls } from "../../hooks/usePublicImageViewportControls.js";
import { AppHeader } from "./AppHeader.js";
import { PublicImageToolbar } from "./PublicImageToolbar.js";

export function PublicImageNavigation({
  embedded,
  animateEntrance,
  route,
  controls
}: {
  embedded: boolean;
  animateEntrance: boolean;
  route: ReturnType<typeof useImageBrowseRoute>;
  controls: ReturnType<typeof usePublicImageViewportControls>;
}) {
  return (
    <div className="public-navigation-frame">
      <div className="public-navigation-stack">
        {!embedded && (
          <AppHeader
            animateEntrance={animateEntrance}
            onMenuExpandedChange={controls.onHeaderMenuExpandedChange}
            browseSearch={route.browseSearch}
            visible={controls.headerVisible}
          />
        )}
        <PublicImageToolbar
          animateEntrance={animateEntrance}
          filters={route.filters}
          facets={route.facets}
          randomUrl={route.randomLink.url}
          randomLinkError={route.randomLink.error}
          tagInvalid={Boolean(route.error)}
          filtersOpen={controls.filtersOpen}
          filterPanelHidden={controls.filterPanelHidden}
          filterMenuDismissSignal={controls.filterMenuDismissSignal}
          toolbarVisible={controls.toolbarVisible}
          toolbarRef={controls.toolbarRef}
          filterToggleRef={controls.filterToggleRef}
          clearFiltersRef={controls.clearFiltersRef}
          filterPanelRef={controls.filterPanelRef}
          toggleFilters={controls.toggleFilters}
          dismissFilterMenus={controls.dismissFilterMenus}
          onFilterChange={route.updateFilter}
          onClearFilters={route.clearFilters}
        />
      </div>
    </div>
  );
}
