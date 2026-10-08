import { useCallback, useId, useRef, type ReactNode, type RefObject } from "react";
import {
  publicImageOrders,
  type GalleryFacetsDto,
  type ShowOrder
} from "@imageshow/shared/browser";
import { CopyableLinkField } from "../actions/CopyableLinkField.js";
import { SelectMenu } from "../form/SelectMenu.js";
import { AnchoredPopup } from "../menu/AnchoredPopup.js";
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

export const publicImageOrderLabels: Record<ShowOrder, string> = {
  random: "随机模式",
  latest: "最新优先",
  oldest: "最旧优先"
};
export const publicImageOrderIcons: Record<ShowOrder, IconName> = {
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
    const label = `排列顺序：${publicImageOrderLabels[order]}；点击切换为${publicImageOrderLabels[next]}`;
    return (
      <button
        type="button"
        className="public-round-control pressable"
        aria-label={label}
        title={label}
        onClick={() => onChange(next)}
      >
        <span className="public-round-surface">
          <Icon name={publicImageOrderIcons[order]} />
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
      options={publicImageOrders.map((value) => ({ value, label: publicImageOrderLabels[value] }))}
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
    getSize: () => {
      const toolbar = triggerRef.current?.closest<HTMLElement>(".gallery-toolbar");
      const toolbarRect = toolbar?.getBoundingClientRect();
      const toolbarStyle = toolbar ? getComputedStyle(toolbar) : null;
      return {
        minWidth,
        horizontalBounds: toolbarRect && toolbarStyle ? {
          left: toolbarRect.left + Number.parseFloat(toolbarStyle.paddingLeft),
          right: toolbarRect.right - Number.parseFloat(toolbarStyle.paddingRight)
        } : undefined,
        align: "end",
        flipThreshold: 180,
        minAvailable: 120,
        maxHeight: 420
      };
    },
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
  filterControls,
  summary: summaryOverride,
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
  /** 当前画面不使用筛选时，占据筛选按钮位置的控件及对应的摘要文字。 */
  filterControls?: ReactNode;
  summary?: string;
  compact?: boolean;
}) {
  const entrance = useOneShotAnimation(animateEntrance);
  const draft = createPublicFilterDraft(filters);
  const tag = draft.tag.kind === "selection" ? draft.tag.selection : createTagSelection();
  const chips = publicFilterChips(draft, tag, facets);
  const count = chips.length;
  const hasFilters = count > 0 || filterInvalid;
  const summary =
    summaryOverride ??
    (filterInvalid
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
        : "全部图片");

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
        {filterControls ?? (
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
        )}
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
                  <CopyableLinkField
                    className="public-toolbar-share-link"
                    value={pageUrl}
                    inputLabel="页面链接"
                    copyLabel="复制页面链接"
                  />
                ) : (
                  <p>请先确认筛选条件</p>
                )}
              </section>
              <section className="public-toolbar-share-item" aria-label="随机图片API">
                <header className="public-toolbar-share-heading">
                  <strong>随机图片API</strong>
                  <p>按当前筛选条件随机获取图片</p>
                </header>
                {randomUrl ? (
                  <CopyableLinkField
                    className="public-toolbar-share-link"
                    value={randomUrl}
                    inputLabel="随机图片API"
                    copyLabel="复制随机图片API链接"
                  />
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
