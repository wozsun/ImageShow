import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useAnchoredMenu } from "../../hooks/useAnchoredMenu.js";
import { Icon } from "../icon/Icon.js";
import { slugPattern } from "../../lib/constants.js";
import { facetDisplayName } from "../../lib/ui/formatters.js";
import type { FacetOption } from "../../lib/types.js";
import {
  handleSuggestionNavigationKey,
  SuggestionList,
  suggestionMenuSize
} from "./SuggestionList.js";

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
  const listId = useId();
  const inputId = `${listId}-input`;
  const { open, closing, position, opensUp, menuRef, openMenu, requestClose, onAnimationEnd } = useAnchoredMenu({
    triggerRef: wrapRef,
    getSize: () => suggestionMenuSize,
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
    if (handleSuggestionNavigationKey(event, {
      open,
      matchCount: matches.length,
      setActiveIndex,
      openMenu,
      requestClose
    })) return;

    if (event.key === "Enter" || event.key === "," || (event.key === " " && !event.nativeEvent.isComposing)) {
      event.preventDefault();
      if (open && activeIndex >= 0 && matches[activeIndex]) addTag(matches[activeIndex].slug);
      else if (text.trim()) addTag(text);
    } else if (event.key === "Backspace" && !text && value.length) {
      removeTag(value[value.length - 1]);
    }
  };

  const menu = (
    <SuggestionList
      open={open}
      matches={matches}
      activeIndex={activeIndex}
      ariaLabel={ariaLabel}
      listId={listId}
      closing={closing}
      opensUp={opensUp}
      position={position}
      popupRef={menuRef}
      onAnimationEnd={onAnimationEnd}
      onActiveIndexChange={setActiveIndex}
      onChoose={addTag}
    />
  );

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
            {facetDisplayName(suggestions, tag)}
            {!disabled && (
              <button
                type="button"
                className="tag-chip-remove"
                aria-label={`移除标签 ${facetDisplayName(suggestions, tag)}`}
                onClick={() => removeTag(tag)}
              >
                <Icon name="close-line" />
              </button>
            )}
          </span>
        );
      })}
      <input
        id={inputId}
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
