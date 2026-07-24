import type {
  AnimationEventHandler,
  CSSProperties,
  Dispatch,
  KeyboardEvent,
  SetStateAction
} from "react";
import { AnchoredPopup } from "../feedback/AnchoredPopup.js";
import type { AnchoredMenuSize } from "../../lib/ui/menu-position.js";
import type { FacetOption } from "../../lib/types.js";

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
  matches: readonly FacetOption[];
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
  if (!open || !matches.length) return null;

  return (
    <AnchoredPopup
      popupRef={popupRef}
      id={listId}
      className={`select-menu suggestion-menu ${opensUp ? "opens-up" : ""} ${closing ? "is-closing" : ""}`}
      role="listbox"
      aria-label={ariaLabel}
      aria-hidden={closing}
      inert={closing}
      style={position}
      onAnimationEnd={onAnimationEnd}
    >
      {matches.map((option, index) => {
        const active = index === activeIndex;
        const selected = selectedSlug !== undefined
          && option.slug === selectedSlug;
        const className = [
          selected ? "is-selected" : "",
          active ? "is-active" : ""
        ].filter(Boolean).join(" ");

        return (
          <button
            key={option.slug}
            type="button"
            role="option"
            aria-selected={selectedSlug === undefined ? active : selected}
            className={className}
            onMouseEnter={() => onActiveIndexChange(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(option.slug)}
          >
            <span>{option.slug}</span>
            {option.display_name && option.display_name !== option.slug && (
              <span className="option-display-name">
                {option.display_name}
              </span>
            )}
          </button>
        );
      })}
    </AnchoredPopup>
  );
}
