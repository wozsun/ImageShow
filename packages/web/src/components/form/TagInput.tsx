import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { vocabularyDisplayNameMaxLength } from "@imageshow/shared/browser";
import { useAnchoredMenu } from "../../hooks/useAnchoredMenu.js";
import { useImeInputSession } from "../../hooks/useImeInputSession.js";
import { Icon } from "../icon/Icon.js";
import {
  facetSuggestions,
  normalizeFacetSearchQuery,
  parseFacetSlug
} from "../../lib/ui/facet-input.js";
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
  const imeSession = useImeInputSession(text);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const choiceSettledCompositionRef = useRef(false);
  const listId = useId();
  const inputId = `${listId}-input`;
  const {
    open,
    closing,
    position,
    opensUp,
    menuRef,
    openMenu,
    requestClose,
    cancelClose,
    onAnimationEnd
  } = useAnchoredMenu({
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

  const query = normalizeFacetSearchQuery(text);
  const selected = new Set(value);

  const knownSlugs = new Set(suggestions.map((option) => option.slug));
  const matches = facetSuggestions(suggestions, query, selected);
  const suggestionOpen = open && matches.length > 0;

  const updateQuery = (nextText: string) => {
    setText(nextText);
    setActiveIndex(-1);
    if (!normalizeFacetSearchQuery(nextText)) {
      if (open) requestClose();
      return;
    }
    if (closing) cancelClose();
    if (!open) openMenu();
  };

  const addTag = (raw: string) => {
    const tag = parseFacetSlug(raw);
    if (
      tag === null
      || selected.has(tag)
    ) return false;
    onChange([...value, tag]);
    setText("");
    setActiveIndex(-1);
    if (open) requestClose();
    return true;
  };
  const chooseTag = (slug: string) => {
    const compositionActive = imeSession.isComposing();
    if (!addTag(slug) || !compositionActive) return;

    // Suggestion presses normally preserve focus so several tags can be
    // chosen quickly. During an active composition we instead end this focus
    // session: WebKit may still dispatch the old compositionend/input pair,
    // which the settled IME guard must reject rather than restore the query.
    choiceSettledCompositionRef.current = true;
    imeSession.settleEditing("");
    inputRef.current?.blur();
  };
  const removeTag = (tag: string) => onChange(value.filter((item) => item !== tag));
  const scrollTags = (direction: -1 | 1) => {
    const box = wrapRef.current;
    if (!box) return false;
    const maxScrollLeft = Math.max(0, box.scrollWidth - box.clientWidth);
    const nextScrollLeft = Math.min(
      maxScrollLeft,
      Math.max(0, box.scrollLeft + direction * Math.max(80, Math.floor(box.clientWidth * 0.65)))
    );
    if (Math.abs(nextScrollLeft - box.scrollLeft) < 1) return false;
    box.scrollLeft = nextScrollLeft;
    return true;
  };

  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      imeSession.isComposing(event.nativeEvent.isComposing)
      || event.keyCode === 229
    ) return;

    if (handleSuggestionNavigationKey(event, {
      open: suggestionOpen,
      matchCount: matches.length,
      setActiveIndex,
      openMenu: () => {
        if (matches.length) openMenu();
      },
      requestClose
    })) return;

    if (event.key === "Enter") {
      event.preventDefault();
      if (open && activeIndex >= 0 && matches[activeIndex]) addTag(matches[activeIndex].slug);
      else if (text.trim()) addTag(text);
    } else if (
      event.key === "ArrowLeft"
      && event.currentTarget.selectionStart === 0
      && event.currentTarget.selectionEnd === 0
      && scrollTags(-1)
    ) {
      event.preventDefault();
    } else if (
      event.key === "ArrowRight"
      && event.currentTarget.selectionStart === text.length
      && event.currentTarget.selectionEnd === text.length
      && scrollTags(1)
    ) {
      event.preventDefault();
    } else if (event.key === "Backspace" && !text && value.length) {
      removeTag(value[value.length - 1]);
    }
  };

  const menu = (
    <SuggestionList
      open={suggestionOpen}
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
      onChoose={chooseTag}
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
        ref={inputRef}
        id={inputId}
        className="tag-input-field"
        value={text}
        maxLength={vocabularyDisplayNameMaxLength}
        onFocus={() => {
          choiceSettledCompositionRef.current = false;
          imeSession.beginEditing();
        }}
        onChange={(event) => {
          if (!imeSession.acceptInput(event.currentTarget)) return;
          const raw = event.currentTarget.value;
          if (imeSession.isComposing(
            (event.nativeEvent as InputEvent).isComposing
          )) {
            setText(raw);
            return;
          }
          updateQuery(raw);
        }}
        onCompositionStart={() => {
          imeSession.beginComposition();
        }}
        onCompositionEnd={(event) => {
          if (!imeSession.endComposition(event.currentTarget)) return;
          updateQuery(event.currentTarget.value);
        }}
        onKeyDown={handleKey}
        onBlur={(event) => {
          if (!choiceSettledCompositionRef.current) {
            addTag(event.currentTarget.value);
          }
          choiceSettledCompositionRef.current = false;
          setText("");
          setActiveIndex(-1);
          imeSession.settleEditing("");
          if (open) requestClose();
        }}
        placeholder={value.length ? "" : placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={suggestionOpen && !closing}
        aria-controls={suggestionOpen ? listId : undefined}
        aria-autocomplete="list"
        autoComplete="off"
      />
      {menu}
    </div>
  );
}
