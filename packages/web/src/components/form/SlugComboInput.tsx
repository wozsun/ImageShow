import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { useAnchoredMenu } from "../../hooks/useAnchoredMenu.js";
import { useImeInputSession } from "../../hooks/useImeInputSession.js";
import { slugPattern } from "../../lib/constants.js";
import {
  facetSuggestions,
  normalizeFacetInput
} from "../../lib/ui/facet-input.js";
import { facetDisplayName } from "../../lib/ui/formatters.js";
import type { FacetOption } from "../../lib/types.js";
import {
  handleSuggestionNavigationKey,
  SuggestionList,
  suggestionMenuSize
} from "./SuggestionList.js";

const hiddenSuggestionSlugs = new Set(["none"]);

export function SlugComboInput({ value, onChange, options, noun, placeholder, disabled = false, ariaLabel, className }: {
  value: string;
  onChange: (value: string) => void;
  options: FacetOption[];
  noun: string;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const [activeIndex, setActiveIndex] = useState(-1);

  const [focused, setFocused] = useState(false);
  const [editingValue, setEditingValue] = useState(value);
  const publishedValueRef = useRef(value);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const renderedValue = focused
    ? editingValue
    : facetDisplayName(options, value);
  const imeSession = useImeInputSession(renderedValue);
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
    publishedValueRef.current = value;
    if (!imeSession.isComposing()) setEditingValue(value);
  }, [value]);

  const publishValue = (raw: string, showSuggestions = true) => {
    const normalized = normalizeFacetInput(raw);
    setEditingValue(normalized);
    if (normalized !== publishedValueRef.current) {
      publishedValueRef.current = normalized;
      onChange(normalized);
    }
    setActiveIndex(-1);
    if (showSuggestions) {
      if (closing) cancelClose();
      if (!open) openMenu();
    }
    return normalized;
  };

  const query = (focused ? editingValue : value).trim().toLowerCase();

  const matches = facetSuggestions(options, query, hiddenSuggestionSlugs);
  const suggestionOpen = open && matches.length > 0;

  const isNew = slugPattern.test(query) && query.length <= 32 && !options.some((option) => option.slug === query);

  const choose = (slug: string) => {
    const normalized = publishValue(slug, false);
    imeSession.settleEditing(facetDisplayName(options, normalized));

    setFocused(false);
    inputRef.current?.blur();
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
      if (!suggestionOpen) return;
      event.preventDefault();
      if (activeIndex >= 0 && matches[activeIndex]) choose(matches[activeIndex].slug);
      else requestClose();
    }
  };

  const menu = (
    <SuggestionList
      open={suggestionOpen}
      matches={matches}
      activeIndex={activeIndex}
      selectedSlug={value}
      ariaLabel={ariaLabel}
      listId={listId}
      closing={closing}
      opensUp={opensUp}
      position={position}
      popupRef={menuRef}
      onAnimationEnd={onAnimationEnd}
      onActiveIndexChange={setActiveIndex}
      onChoose={choose}
    />
  );

  return (
    <div className={`slug-combo-control ${className ?? ""}`.trim()} ref={wrapRef}>
      <input
        ref={inputRef}
        id={inputId}
        value={renderedValue}
        maxLength={32}
        onFocus={() => {
          setEditingValue(value);
          publishedValueRef.current = value;
          imeSession.beginEditing();
          setFocused(true);
        }}
        onBlur={(event) => {
          const normalized = imeSession.isComposing()
            ? publishValue(event.currentTarget.value, false)
            : publishedValueRef.current;
          imeSession.settleEditing(facetDisplayName(options, normalized));
          setFocused(false);
          if (open) requestClose();
        }}
        onChange={(event) => {
          if (!imeSession.acceptInput(event.currentTarget)) return;
          const raw = event.currentTarget.value;
          if (imeSession.isComposing(
            (event.nativeEvent as InputEvent).isComposing
          )) {
            setEditingValue(raw);
            return;
          }
          publishValue(raw);
        }}
        onCompositionStart={() => {
          imeSession.beginComposition();
        }}
        onCompositionEnd={(event) => {
          if (!imeSession.endComposition(event.currentTarget)) return;
          publishValue(
            event.currentTarget.value,
            document.activeElement === event.currentTarget
          );
        }}
        onKeyDown={handleKey}
        placeholder={placeholder ?? noun}
        disabled={disabled}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={suggestionOpen && !closing}
        aria-controls={suggestionOpen ? listId : undefined}
        aria-autocomplete="list"
        data-new-slug={isNew || undefined}
        title={isNew ? `「${query}」是新${noun}，提交后会自动创建` : undefined}
        autoComplete="off"
      />
      {menu}
    </div>
  );
}
