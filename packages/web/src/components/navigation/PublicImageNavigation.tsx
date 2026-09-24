import type { useImageBrowseRoute } from "../../hooks/useImageBrowseRoute.js";
import type { usePublicImageViewportControls } from "../../hooks/usePublicImageViewportControls.js";
import type { usePublicFilterDialog } from "../../hooks/usePublicFilterDialog.js";
import type { ShowOrder, ShowMode } from "@imageshow/shared/browser";
import type { ReactNode } from "react";
import { AppHeader } from "./AppHeader.js";
import { PublicImageOrderControl, PublicImageToolbar } from "./PublicImageToolbar.js";
import { mobileViewportMediaQuery, useMediaQuery } from "../../hooks/useMediaQuery.js";

export function PublicImageNavigation({
  embedded,
  animateEntrance,
  route,
  controls,
  filterDialog,
  order,
  mode,
  onOrderChange,
  leadingControls,
  viewControls,
  mobileTrailingControls,
  floatingControlsHidden = false
}: {
  embedded: boolean;
  animateEntrance: boolean;
  route: ReturnType<typeof useImageBrowseRoute>;
  controls: ReturnType<typeof usePublicImageViewportControls>;
  filterDialog: ReturnType<typeof usePublicFilterDialog>;
  order: ShowOrder;
  mode?: ShowMode;
  onOrderChange: (order: ShowOrder) => void;
  leadingControls?: ReactNode;
  viewControls?: ReactNode;
  mobileTrailingControls?: ReactNode;
  floatingControlsHidden?: boolean;
}) {
  const mobile = useMediaQuery(mobileViewportMediaQuery);
  const orderControl = <PublicImageOrderControl order={order} onChange={onOrderChange} compact />;
  return (
    <><div className="public-navigation-frame">
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
          compact={mobile}
          embedded={embedded}
          animateEntrance={animateEntrance}
          filters={route.filters}
          facets={route.facets}
          randomUrl={route.randomLink.url}
          pageUrl={route.getPageUrl(order, mode)}
          randomLinkError={route.randomLink.error}
          filterInvalid={Boolean(route.error)}
          filtersOpen={filterDialog.active}
          toolbarVisible={controls.toolbarVisible}
          toolbarRef={controls.toolbarRef}
          filterToggleRef={filterDialog.triggerRef}
          onOpenFilters={filterDialog.open}
          onClearFilters={route.clearFilters}
          order={order}
          onOrderChange={onOrderChange}
          leadingControls={leadingControls}
          viewControls={viewControls}
        />
      </div>
    </div>
    {mobile && leadingControls && <>
      <div className="public-mobile-controls is-leading public-floating-controls" data-show-control=""
        data-public-navigation-visible={controls.headerVisible || controls.toolbarVisible}
        role="group" aria-label="图片大小" hidden={floatingControlsHidden}>
        {leadingControls}
      </div>
      <div className="public-mobile-controls is-trailing public-floating-controls" data-show-control=""
        data-public-navigation-visible={controls.headerVisible || controls.toolbarVisible}
        role="group" aria-label="展映播放与模式" hidden={floatingControlsHidden}>
        {orderControl}{mobileTrailingControls}
      </div>
    </>}
    </>
  );
}
