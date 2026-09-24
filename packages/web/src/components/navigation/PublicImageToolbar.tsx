import { useCallback, useId, useRef, type ReactNode, type RefObject } from "react";
import {
  publicImageOrders,
  type GalleryFacetsDto,
  type ShowOrder
} from "@imageshow/shared/browser";
import { CopyButton } from "../actions/CopyButton.js";
import { SelectMenu } from "../form/SelectMenu.js";
import { AnchoredPopup } from "../feedback/AnchoredPopup.js";
import { Icon, type IconName } from "../icon/Icon.js";
import { useAnchoredMenu } from "../../hooks/useAnchoredMenu.js";
import { useOneShotAnimation } from "../../hooks/useOneShotAnimation.js";
import type { GalleryFilters } from "../../lib/gallery/gallery-query.js";
import {
  createPublicFilterDraft,
  createTagSelection,
  publicFilterChips,
  publicFilterLabels,
  publicFilterSections
} from "../../lib/gallery/public-filter-draft.js";

const orderLabels: Record<ShowOrder, string> = {
  random: "随机模式",
  latest: "最新优先",
  oldest: "最旧优先"
};
const orderIcons: Record<ShowOrder, IconName> = {
  random: "shuffle-line",
  latest: "sort-desc",
  oldest: "sort-asc"
};

export function PublicImageOrderControl({
  order,
  onChange,
  compact = false
}: {
  order: ShowOrder;
  onChange: (order: ShowOrder) => void;
  compact?: boolean;
}) {
  if (compact) {
    const next =
      publicImageOrders[(publicImageOrders.indexOf(order) + 1) % publicImageOrders.length]!;
    const label = `排列顺序：${orderLabels[order]}；点击切换为${orderLabels[next]}`;
    return (
      <button
        type="button"
        className="public-round-control pressable"
        aria-label={label}
        title={label}
        onClick={() => onChange(next)}
      >
        <span className="public-round-surface">
          <Icon name={orderIcons[order]} />
        </span>
      </button>
    );
  }
  return (
    <SelectMenu
      value={order}
      onChange={(value) => onChange(value as ShowOrder)}
      ariaLabel="排列顺序"
      className="public-toolbar-order"
      menuClassName="public-gallery-menu"
      options={publicImageOrders.map((value) => ({ value, label: orderLabels[value] }))}
    />
  );
}

export function PublicToolbarPopover({
  label,
  icon,
  iconOnly = false,
  minWidth = 280,
  autoFocus = true,
  openerRef,
  children
}: {
  label: string;
  icon: IconName;
  iconOnly?: boolean;
  minWidth?: number;
  autoFocus?: boolean;
  openerRef?: RefObject<HTMLButtonElement | null>;
  children: (close: () => void) => ReactNode;
}) {
  const ownTriggerRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = openerRef ?? ownTriggerRef;
  const contentRef = useRef<HTMLElement | null>(null);
  const id = useId();
  const menu = useAnchoredMenu({
    triggerRef,
    getSize: () => ({
      minWidth,
      maxWidth: window.innerWidth - 24,
      align: "end",
      flipThreshold: 180,
      minAvailable: 120,
      maxHeight: 420
    }),
    initialMaxHeight: 420,
    closeOnEscape: true,
    closeOnFocusOutside: true,
    focusOnOpen: () =>
      autoFocus ? contentRef.current?.querySelector<HTMLElement>("button, a, input") : null,
    focusAfterClose: () => triggerRef.current
  });
  const bindMenuRef = useCallback(
    (element: HTMLElement | null) => {
      contentRef.current = element;
      menu.menuRef(element);
    },
    [menu.menuRef]
  );
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`public-toolbar-button${iconOnly ? " is-icon" : ""}`}
        aria-label={label}
        title={iconOnly ? label : undefined}
        aria-expanded={menu.open}
        aria-controls={id}
        onClick={() => (menu.open ? menu.requestCloseAndRestoreFocus() : menu.openMenu())}
      >
        <Icon name={icon} />
        {!iconOnly && label}
      </button>
      {menu.open && (
        <AnchoredPopup
          id={id}
          popupRef={bindMenuRef}
          className={`public-toolbar-popover public-gallery-menu${menu.closing ? " is-closing" : ""}`}
          role="region"
          aria-label={label}
          style={menu.position}
          aria-hidden={menu.closing}
          inert={menu.closing}
          onAnimationEnd={menu.onAnimationEnd}
        >
          {children(menu.requestCloseAndRestoreFocus)}
        </AnchoredPopup>
      )}
    </>
  );
}

export function PublicImageToolbar({
  embedded,
  animateEntrance,
  filters,
  facets,
  pageUrl,
  randomUrl,
  randomLinkError,
  filterInvalid = false,
  toolbarVisible,
  toolbarRef,
  filterToggleRef,
  filtersOpen,
  onOpenFilters,
  onClearFilters,
  order,
  onOrderChange,
  leadingControls,
  viewControls,
  compact = false
}: {
  embedded: boolean;
  animateEntrance: boolean;
  filters: GalleryFilters;
  facets: GalleryFacetsDto | undefined;
  pageUrl: string | null;
  randomUrl: string | null;
  randomLinkError?: string | null;
  filterInvalid?: boolean;
  toolbarVisible: boolean;
  toolbarRef: RefObject<HTMLElement | null>;
  filterToggleRef: RefObject<HTMLButtonElement | null>;
  filtersOpen: boolean;
  onOpenFilters: () => void;
  onClearFilters: () => void;
  order: ShowOrder;
  onOrderChange: (order: ShowOrder) => void;
  leadingControls?: ReactNode;
  viewControls?: ReactNode;
  compact?: boolean;
}) {
  const entrance = useOneShotAnimation(animateEntrance);
  const draft = createPublicFilterDraft(filters);
  const tag = draft.tag.kind === "selection" ? draft.tag.selection : createTagSelection();
  const chips = publicFilterChips(draft, tag, facets);
  const count = chips.length;
  const hasFilters = count > 0 || filterInvalid;
  const summary = filterInvalid
    ? "筛选条件待处理"
    : count
      ? publicFilterSections
          .flatMap((section) => {
            const group = chips.filter((chip) => chip.section === section);
            if (!group.length) return [];
            if (section === "device" || section === "brightness") return [group[0].label];
            return [
              `${group[0].exclude ? "排除" : ""}${publicFilterLabels[section]} ${group.length} 项`
            ];
          })
          .join(" · ")
      : "全部图片";

  return (
    <section
      ref={toolbarRef}
      className={`gallery-toolbar public-navigation-secondary${entrance.active ? " is-gallery-toolbar-entrance" : ""}${toolbarVisible ? "" : " is-scroll-hidden"}`}
      aria-label="图片浏览工具栏"
      inert={!toolbarVisible}
      onAnimationEnd={(event) => {
        if (
          event.currentTarget === event.target &&
          event.animationName === "gallery-toolbar-entrance"
        )
          entrance.finish();
      }}
    >
      <div className="public-toolbar-leading">
        {!compact && leadingControls}
        <div
          className={`public-filter-buttons${hasFilters ? " has-filters" : ""}`}
          role="group"
          aria-label="筛选操作"
        >
          <button
            ref={filterToggleRef}
            type="button"
            className="public-toolbar-button public-filter-trigger"
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
            onClick={onOpenFilters}
          >
            {!hasFilters && <Icon name="filter-3-line" />}
            {hasFilters ? "重新筛选" : "筛选"}
          </button>
          {hasFilters && (
            <button
              type="button"
              className="public-toolbar-button public-filter-clear"
              onClick={() => {
                filterToggleRef.current?.focus({ preventScroll: true });
                onClearFilters();
              }}
            >
              清空
            </button>
          )}
        </div>
      </div>
      {!compact && (
        <span className="public-toolbar-summary" title={summary}>
          {summary}
        </span>
      )}
      <div className="public-toolbar-actions">
        {!compact && (
          <>
            <PublicImageOrderControl order={order} onChange={onOrderChange} />
            {viewControls}
          </>
        )}
        <PublicToolbarPopover
          label="分享"
          icon="share-line"
          iconOnly
          minWidth={480}
          autoFocus={false}
        >
          {() => (
            <>
              <section className="public-toolbar-share-item" aria-label="页面链接">
                <header className="public-toolbar-share-heading">
                  <strong>页面链接</strong>
                  <p>
                    {embedded
                      ? "链接将打开图库主站，保留当前筛选、排序与浏览模式"
                      : "保留当前筛选、排列顺序与浏览模式"}
                  </p>
                </header>
                {pageUrl ? (
                  <div className="public-toolbar-share-link">
                    <input
                      readOnly
                      value={pageUrl}
                      aria-label="页面链接"
                      onClick={(event) => event.currentTarget.select()}
                    />
                    <CopyButton value={pageUrl} ariaLabel="复制页面链接" />
                  </div>
                ) : (
                  <p>请先确认筛选条件</p>
                )}
              </section>
              <section className="public-toolbar-share-item" aria-label="随机 API 链接">
                <header className="public-toolbar-share-heading">
                  <strong>随机 API 链接</strong>
                  <p>按当前筛选条件随机获取图片</p>
                </header>
                {randomUrl ? (
                  <div className="public-toolbar-share-link">
                    <input
                      readOnly
                      value={randomUrl}
                      aria-label="随机 API 链接"
                      onClick={(event) => event.currentTarget.select()}
                    />
                    <CopyButton value={randomUrl} ariaLabel="复制随机 API 链接" />
                  </div>
                ) : (
                  <p role={randomLinkError ? "alert" : undefined}>
                    {randomLinkError ?? "请先确认筛选条件"}
                  </p>
                )}
              </section>
            </>
          )}
        </PublicToolbarPopover>
      </div>
    </section>
  );
}
