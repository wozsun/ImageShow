import { useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useAnchoredMenu } from "../../hooks/useAnchoredMenu.js";
import { reservedSubdomains, slugPattern } from "../../lib/constants.js";
import type { AnchoredMenuSize } from "../../lib/ui/menu-position.js";
import type { FacetOption } from "../../lib/types.js";

const MENU_SIZE: AnchoredMenuSize = { minWidth: 0, flipThreshold: 180, minAvailable: 96, maxHeight: 260 };

export function SlugComboInput({ value, onChange, options, noun, checkReserved = false, placeholder, disabled = false, ariaLabel, className }: {
  value: string;
  onChange: (value: string) => void;
  options: FacetOption[];
  noun: string;
  checkReserved?: boolean;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const [activeIndex, setActiveIndex] = useState(-1);

  const [focused, setFocused] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const nameFor = (slug: string) => options.find((option) => option.slug === slug)?.display_name || slug;
  const { open, closing, position, opensUp, openMenu, requestClose, onAnimationEnd } = useAnchoredMenu({
    triggerRef: wrapRef,
    menuRef,
    getSize: () => MENU_SIZE,
    initialMaxHeight: 260,
    disabled,
    onClose: () => setActiveIndex(-1)
  });

  const query = value.trim().toLowerCase();

  const matches = query
    ? options.filter((option) => option.slug !== "none" && (option.slug.includes(query) || option.display_name.toLowerCase().includes(query))).slice(0, 50)
    : [];

  const reserved = checkReserved && (reservedSubdomains as readonly string[]).includes(query);

  const isNew = slugPattern.test(query) && query.length <= 32 && !reserved && !options.some((option) => option.slug === query);

  const choose = (slug: string) => {
    onChange(slug);
    requestClose();

    setFocused(false);
    inputRef.current?.blur();
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
      if (activeIndex >= 0 && matches[activeIndex]) choose(matches[activeIndex].slug);
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
      {matches.map((option, index) => (
        <button
          key={option.slug}
          type="button"
          role="option"
          aria-selected={option.slug === value}
          className={`${option.slug === value ? "is-selected" : ""} ${index === activeIndex ? "is-active" : ""}`}
          onMouseEnter={() => setActiveIndex(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(option.slug)}
        >
          <span>{option.slug}</span>
          {option.display_name && option.display_name !== option.slug && (
            <span className="facet-slug">{option.display_name}</span>
          )}
        </button>
      ))}
    </div>,
    document.body
  ) : null;

  return (
    <div className={`theme-input-control ${className ?? ""}`.trim()} ref={wrapRef}>
      <input
        ref={inputRef}
        value={focused ? value : nameFor(value)}
        maxLength={32}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => { onChange(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); setActiveIndex(-1); if (!open) openMenu(); }}
        onKeyDown={handleKey}
        placeholder={placeholder ?? noun}
        disabled={disabled}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open && !closing}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-invalid={reserved || undefined}
        data-new-theme={isNew || undefined}
        title={reserved ? `「${query}」是保留子域名前缀，不能作为${noun}` : isNew ? `「${query}」是新${noun}，提交后会自动创建` : undefined}
        autoComplete="off"
      />
      {menu}
    </div>
  );
}
