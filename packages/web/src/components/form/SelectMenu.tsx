import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { AnchoredPopup } from "../feedback/AnchoredPopup.js";
import { useAnchoredMenu } from "../../hooks/useAnchoredMenu.js";
import type { AnchoredMenuSize } from "../../lib/ui/menu-position.js";
import type { SelectOption } from "../../lib/ui/select-options.js";

const MENU_SIZE: AnchoredMenuSize = { minWidth: 120, flipThreshold: 180, minAvailable: 96, maxHeight: 240 };

export function SelectMenu({
  value,
  options,
  onChange,
  onOpenChange,
  disabled = false,
  ariaLabel,
  className
}: {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const onOpenChangeRef = useRef(onOpenChange);
  const reportedOpenRef = useRef(false);
  onOpenChangeRef.current = onOpenChange;
  const reportOpen = (nextOpen: boolean) => {
    if (reportedOpenRef.current === nextOpen) return;
    reportedOpenRef.current = nextOpen;
    onOpenChangeRef.current?.(nextOpen);
  };
  const menuId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex] ?? { value, label: value };
  const { open, closing, position, opensUp, menuRef, openMenu, requestClose, onAnimationEnd } = useAnchoredMenu({
    triggerRef,
    getSize: () => MENU_SIZE,
    initialMaxHeight: 240,
    disabled,
    onClose: () => reportOpen(false),
    closeOnEscape: true,
    closeOnFocusOutside: true,
    focusOnOpen: () => optionRefs.current[selectedIndex]
  });
  const handleOpen = () => {
    reportOpen(true);
    openMenu();
  };
  useEffect(() => () => reportOpen(false), []);

  const choose = (nextValue: string) => {
    if (nextValue !== value) onChange(nextValue);
    requestClose(() => triggerRef.current?.focus());
  };

  const handleOptionKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = options.length - 1;
    let next = index;
    if (event.key === "ArrowDown") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowUp") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else return;
    event.preventDefault();
    optionRefs.current[next]?.focus();
  };

  const menu = open ? (
      <AnchoredPopup
        popupRef={menuRef}
        id={menuId}
        className={`select-menu ${opensUp ? "opens-up" : ""} ${closing ? "is-closing" : ""}`}
        role="listbox"
        aria-label={ariaLabel}
        aria-hidden={closing}
        inert={closing}
        style={position}
        onAnimationEnd={onAnimationEnd}
      >
        {options.map((option, index) => (
          <button
            ref={(element) => { optionRefs.current[index] = element; }}
            key={option.value}
            className={option.value === value ? "is-selected" : ""}
            type="button"
            role="option"
            aria-selected={option.value === value}
            onKeyDown={(event) => handleOptionKey(event, index)}
            onClick={() => choose(option.value)}
          >
            <span>{option.label}</span>
          </button>
        ))}
      </AnchoredPopup>
    ) : null;

  return (
    <div className={`select-control ${className ?? ""}`.trim()}>
      <button
        ref={triggerRef}
        className={`select-trigger ${open && !closing ? "is-open" : ""}`}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open && !closing}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          if (!open) handleOpen();
        }}
        onClick={() => open ? requestClose() : handleOpen()}
      >
        <span>{selected.label}</span>
      </button>
      {menu}
    </div>
  );
}
