import type {
  AnimationEventHandler,
  CSSProperties,
  Dispatch,
  KeyboardEvent,
  SetStateAction
} from "react";
import { AnchoredPopup } from "../feedback/AnchoredPopup.js";
import { MenuItemButton } from "../feedback/MenuItemButton.js";
import { FacetSuggestionLabel } from "../data-display/FacetSuggestionLabel.js";
import type { AnchoredMenuSize } from "../../lib/ui/menu-position.js";
import type { FacetSuggestion } from "../../lib/ui/facet-input.js";

export const suggestionMenuSize: AnchoredMenuSize = {
  minWidth: 0,
  flipThreshold: 180,
  minAvailable: 96,
  maxHeight: 260
};

export function handleSuggestionNavigationKey(
  event: KeyboardEvent<HTMLInputElement>,
  {
    open,
    matchCount,
    setActiveIndex,
    openMenu,
    requestClose
  }: {
    open: boolean;
    matchCount: number;
    setActiveIndex: Dispatch<SetStateAction<number>>;
    openMenu: () => void;
    requestClose: () => void;
  }
) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!open) openMenu();
    else setActiveIndex((current) => Math.min(current + 1, matchCount - 1));
    return true;
  }
  if (event.key === "ArrowUp") {
    if (!open) return false;
    event.preventDefault();
    setActiveIndex((current) => Math.max(current - 1, 0));
    return true;
  }
  if (event.key === "Escape" && open) {
    event.preventDefault();
    requestClose();
    return true;
  }
  return false;
}

export function SuggestionList({
  open,
  matches,
  statusMessage,
  activeIndex,
  selectedSlug,
  ariaLabel,
  listId,
  closing,
  opensUp,
  position,
  popupRef,
  onAnimationEnd,
  onActiveIndexChange,
  onChoose
}: {
  open: boolean;
  matches: readonly FacetSuggestion[];
  statusMessage?: string;
  activeIndex: number;
  selectedSlug?: string;
  ariaLabel?: string;
  listId: string;
  closing: boolean;
  opensUp: boolean;
  position: CSSProperties;
  popupRef: (node: HTMLElement | null) => void;
  onAnimationEnd: AnimationEventHandler<HTMLElement>;
  onActiveIndexChange: (index: number) => void;
  onChoose: (slug: string) => void;
}) {
  if (!open) return null;

  return (
    <AnchoredPopup
      popupRef={popupRef}
      overlayScrollbar
      id={listId}
      className={`select-menu suggestion-menu ${opensUp ? "opens-up" : ""} ${closing ? "is-closing" : ""}`}
      role="listbox"
      aria-label={ariaLabel}
      aria-hidden={closing}
      inert={closing}
      style={position}
      onAnimationEnd={onAnimationEnd}
    >
      {statusMessage && (
        <div className="suggestion-status muted" role="status">
          {statusMessage}
        </div>
      )}
      {matches.map((option, index) => {
        const active = index === activeIndex;
        const selected = selectedSlug !== undefined
          && option.slug === selectedSlug;

        return (
          <MenuItemButton
            key={option.slug}
            type="button"
            role="option"
            aria-selected={selectedSlug === undefined ? active : selected}
            className={active ? "is-active" : undefined}
            onMouseEnter={() => onActiveIndexChange(index)}
            pointerFocus="preserve"
            onActivate={() => onChoose(option.slug)}
          >
            <FacetSuggestionLabel option={option} />
          </MenuItemButton>
        );
      })}
    </AnchoredPopup>
  );
}
