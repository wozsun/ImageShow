import { useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useAnchoredMenu } from "./useAnchoredMenu.js";
import { reservedSubdomains } from "../lib/constants.js";
import type { AnchoredMenuSize } from "../lib/menu-position.js";

const MENU_SIZE: AnchoredMenuSize = { minWidth: 0, flipThreshold: 180, minAvailable: 96, maxHeight: 260 };

// A free-text theme box with a styled typeahead dropdown. The text input is the
// trigger (you type the theme directly), and matching themes appear in a menu
// styled to match the rest of the admin selects instead of the native datalist.
export function ThemeInput({ value, onChange, themes, placeholder = "主题", disabled = false, ariaLabel, className }: {
  value: string;
  onChange: (value: string) => void;
  themes: string[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const { open, closing, position, opensUp, openMenu, requestClose, onAnimationEnd } = useAnchoredMenu({
    triggerRef: wrapRef,
    menuRef,
    getSize: () => MENU_SIZE,
    initialMaxHeight: 260,
    disabled,
    onClose: () => setActiveIndex(-1)
  });

  const query = value.trim().toLowerCase();
  // Only suggest once something is typed; an empty box shows no dropdown.
  const matches = query ? themes.filter((theme) => theme.includes(query)).slice(0, 50) : [];
  // A theme equal to a reserved subdomain prefix collides with the random API /
  // static object host, so the server rejects it; warn inline before submitting.
  const reserved = (reservedSubdomains as readonly string[]).includes(query);

  const choose = (theme: string) => {
    onChange(theme);
    requestClose();
  };

  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) { openMenu(); return; }
      setActiveIndex((current) => Math.min(current + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      if (!open) return;
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      if (activeIndex >= 0 && matches[activeIndex]) choose(matches[activeIndex]);
      else requestClose();
    } else if (event.key === "Escape") {
      if (!open) return;
      event.preventDefault();
      requestClose();
    }
  };

  const menu = open && matches.length && typeof document !== "undefined" ? createPortal(
    <div
      ref={menuRef}
      id={listId}
      className={`select-menu theme-combo-menu ${opensUp ? "opens-up" : ""} ${closing ? "is-closing" : ""}`}
      role="listbox"
      aria-label={ariaLabel}
      aria-hidden={closing}
      style={position}
      onAnimationEnd={onAnimationEnd}
    >
      {matches.map((theme, index) => (
        <button
          key={theme}
          type="button"
          role="option"
          aria-selected={theme === value}
          className={`${theme === value ? "is-selected" : ""} ${index === activeIndex ? "is-active" : ""}`}
          onMouseEnter={() => setActiveIndex(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(theme)}
        ><span>{theme}</span></button>
      ))}
    </div>,
    document.body
  ) : null;

  return (
    <div className={`theme-input-control ${className ?? ""}`.trim()} ref={wrapRef}>
      <input
        value={value}
        onChange={(event) => { onChange(event.target.value.toLowerCase()); setActiveIndex(-1); if (!open) openMenu(); }}
        onKeyDown={handleKey}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open && !closing}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-invalid={reserved || undefined}
        title={reserved ? `「${query}」是保留子域名前缀，不能作为主题` : undefined}
        autoComplete="off"
      />
      {menu}
    </div>
  );
}
