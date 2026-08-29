import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { vocabularyDisplayNameMaxLength } from "@imageshow/shared/browser";
import { useAnchoredMenu } from "../../hooks/useAnchoredMenu.js";
import { useImeInputSession } from "../../hooks/useImeInputSession.js";
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

const hiddenSuggestionSlugs = new Set(["none"]);

export function SlugComboInput({
  value,
  onChange,
  options,
  noun,
  placeholder,
  disabled = false,
  ariaLabel,
  className,
  publishTypedChanges = true,
  onFocus,
  onBlur
}: {
  value: string;
  onChange: (value: string) => void;
  options: FacetOption[];
  noun: string;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  publishTypedChanges?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(-1);

  const [focused, setFocused] = useState(false);
  const [editingValue, setEditingValue] = useState(value);
  const publishedValueRef = useRef(value);
  const pendingChoiceRef = useRef<string | null>(null);
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
    if (!focused && !imeSession.isComposing()) setEditingValue(value);
  }, [focused, value]);

  const publishSlug = (slug: string) => {
    if (slug !== publishedValueRef.current) {
      publishedValueRef.current = slug;
      onChange(slug);
    }
  };

  const updateQuery = (nextValue: string) => {
    setEditingValue(nextValue);
    if (publishTypedChanges) publishSlug(parseFacetSlug(nextValue) ?? "");
    setActiveIndex(-1);
    if (!normalizeFacetSearchQuery(nextValue)) {
      if (open) requestClose();
      return;
    }
    if (closing) cancelClose();
    if (!open) openMenu();
  };

  const query = normalizeFacetSearchQuery(focused ? editingValue : value);

  const matches = facetSuggestions(options, query, hiddenSuggestionSlugs);
  const suggestionOpen = open && matches.length > 0;

  const typedSlug = parseFacetSlug(focused ? editingValue : value);
  const isNew = typedSlug !== null
    && !options.some((option) => option.slug === typedSlug);

  const commitAndBlur = (slug: string) => {
    pendingChoiceRef.current = slug;
    setEditingValue(slug);
    publishSlug(slug);
    imeSession.settleEditing(facetDisplayName(options, slug));

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
      event.preventDefault();
      if (suggestionOpen && activeIndex >= 0 && matches[activeIndex]) {
        commitAndBlur(matches[activeIndex].slug);
        return;
      }
      const slug = parseFacetSlug(editingValue);
      if (slug !== null) {
        commitAndBlur(slug);
      } else if (suggestionOpen) {
        requestClose();
      }
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
      onChoose={commitAndBlur}
    />
  );

  return (
    <div className={`slug-combo-control ${className ?? ""}`.trim()} ref={wrapRef}>
      <input
        ref={inputRef}
        id={inputId}
        value={renderedValue}
        maxLength={vocabularyDisplayNameMaxLength}
        onFocus={() => {
          pendingChoiceRef.current = null;
          setEditingValue(value);
          publishedValueRef.current = value;
          imeSession.beginEditing();
          setFocused(true);
          onFocus?.();
        }}
        onBlur={(event) => {
          const chosenSlug = pendingChoiceRef.current;
          pendingChoiceRef.current = null;
          const slug = chosenSlug ?? parseFacetSlug(event.currentTarget.value) ?? "";
          publishSlug(slug);
          setEditingValue(slug);
          imeSession.settleEditing(facetDisplayName(options, slug));
          setFocused(false);
          if (open) requestClose();
          onBlur?.();
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
        placeholder={placeholder ?? noun}
        disabled={disabled}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={suggestionOpen && !closing}
        aria-controls={suggestionOpen ? listId : undefined}
        aria-autocomplete="list"
        data-new-slug={isNew || undefined}
        title={isNew ? `「${typedSlug}」是新${noun}，提交后会自动创建` : undefined}
        autoComplete="off"
      />
      {menu}
    </div>
  );
}
