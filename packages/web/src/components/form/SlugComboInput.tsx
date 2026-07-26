import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { useAnchoredMenu } from "../../hooks/useAnchoredMenu.js";
import { useImeInputSession } from "../../hooks/useImeInputSession.js";
import { reservedSubdomains, slugPattern } from "../../lib/constants.js";
import { normalizeFacetInput } from "../../lib/ui/facet-input.js";
import { facetDisplayName } from "../../lib/ui/formatters.js";
import type { FacetOption } from "../../lib/types.js";
import {
  handleSuggestionNavigationKey,
  SuggestionList,
  suggestionMenuSize
} from "./SuggestionList.js";

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
  const { open, closing, position, opensUp, menuRef, openMenu, requestClose, onAnimationEnd } = useAnchoredMenu({
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
    if (showSuggestions && !open) openMenu();
    return normalized;
  };

  const query = (focused ? editingValue : value).trim().toLowerCase();

  const matches = query
    ? options.filter((option) => option.slug !== "none" && (option.slug.includes(query) || option.display_name.toLowerCase().includes(query))).slice(0, 50)
    : [];

  const reserved = checkReserved && (reservedSubdomains as readonly string[]).includes(query);

  const isNew = slugPattern.test(query) && query.length <= 32 && !reserved && !options.some((option) => option.slug === query);

  const choose = (slug: string) => {
    const normalized = publishValue(slug, false);
    imeSession.settleEditing(facetDisplayName(options, normalized));
    requestClose();

    setFocused(false);
    inputRef.current?.blur();
  };

  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      imeSession.isComposing(event.nativeEvent.isComposing)
      || event.keyCode === 229
    ) return;

    if (handleSuggestionNavigationKey(event, {
      open,
      matchCount: matches.length,
      setActiveIndex,
      openMenu,
      requestClose
    })) return;

    if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      if (activeIndex >= 0 && matches[activeIndex]) choose(matches[activeIndex].slug);
      else requestClose();
    }
  };

  const menu = (
    <SuggestionList
      open={open}
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
        aria-expanded={open && !closing}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-invalid={reserved || undefined}
        data-new-slug={isNew || undefined}
        title={reserved ? `「${query}」是保留子域名前缀，不能作为${noun}` : isNew ? `「${query}」是新${noun}，提交后会自动创建` : undefined}
        autoComplete="off"
      />
      {menu}
    </div>
  );
}
