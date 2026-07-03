import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useAnchoredMenu } from "../../hooks/useAnchoredMenu.js";
import { Icon } from "../icon/Icon.js";
import { slugPattern } from "../../lib/constants.js";
import type { AnchoredMenuSize } from "../../lib/ui/menu-position.js";
import type { FacetOption } from "../../lib/types.js";

const MENU_SIZE: AnchoredMenuSize = { minWidth: 0, flipThreshold: 180, minAvailable: 96, maxHeight: 260 };

export function TagInput({ value, onChange, suggestions, disabled = false, ariaLabel, className, placeholder = "添加标签" }: {
  value: string[];
  onChange: (value: string[]) => void;
  suggestions: FacetOption[];
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
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

  useEffect(() => {
    const box = wrapRef.current;
    if (box && box.contains(document.activeElement)) box.scrollLeft = box.scrollWidth;
  }, [text, value]);

  const query = text.trim().toLowerCase();
  const selected = new Set(value);

  const knownSlugs = new Set(suggestions.map((option) => option.slug));
  const nameFor = (slug: string) => suggestions.find((option) => option.slug === slug)?.display_name || slug;
  const matches = suggestions
    .filter((tag) => !selected.has(tag.slug) && (query ? (tag.slug.includes(query) || tag.display_name.toLowerCase().includes(query)) : true))
    .slice(0, 50);

  const addTag = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (!tag || selected.has(tag) || tag.length > 32 || !slugPattern.test(tag)) return;
    onChange([...value, tag]);
    setText("");
    setActiveIndex(-1);
  };
  const removeTag = (tag: string) => onChange(value.filter((item) => item !== tag));

  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) { openMenu(); return; }
      setActiveIndex((current) => Math.min(current + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      if (!open) return;
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter" || event.key === "," || (event.key === " " && !event.nativeEvent.isComposing)) {

      event.preventDefault();
      if (open && activeIndex >= 0 && matches[activeIndex]) addTag(matches[activeIndex].slug);
      else if (text.trim()) addTag(text);
    } else if (event.key === "Backspace" && !text && value.length) {
      removeTag(value[value.length - 1]);
    } else if (event.key === "Escape" && open) {
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
      {matches.map((tag, index) => (
        <button
          key={tag.slug}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={index === activeIndex ? "is-active" : ""}
          onMouseEnter={() => setActiveIndex(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => addTag(tag.slug)}
        >
          <span>{tag.slug}</span>
          {tag.display_name && tag.display_name !== tag.slug && (
            <span className="facet-slug">{tag.display_name}</span>
          )}
        </button>
      ))}
    </div>,
    document.body
  ) : null;

  return (
    <div className={`tag-input-control ${className ?? ""}`.trim()} ref={wrapRef}>
      {value.map((tag) => {
        const isNew = !knownSlugs.has(tag);
        return (
          <span
            key={tag}
            className={`tag-chip${isNew ? " is-new" : ""}`}
            title={isNew ? `「${tag}」是新标签，提交后会自动创建` : undefined}
          >
            {nameFor(tag)}
            {!disabled && (
              <button
                type="button"
                className="tag-chip-remove"
                aria-label={`移除标签 ${nameFor(tag)}`}
                onClick={() => removeTag(tag)}
              >
                <Icon name="close-line" />
              </button>
            )}
          </span>
        );
      })}
      <input
        className="tag-input-field"
        value={text}
        maxLength={32}
        onChange={(event) => { setText(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); setActiveIndex(-1); if (!open) openMenu(); }}
        onKeyDown={handleKey}
        onBlur={() => { if (text.trim()) addTag(text); }}
        placeholder={value.length ? "" : placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open && !closing}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        autoComplete="off"
      />
      {menu}
    </div>
  );
}
