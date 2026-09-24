import { basicTagSelection, basicTagValue, TagFilterError } from "@imageshow/shared/browser";
import { FacetSuggestionLabel } from "./FacetSuggestionLabel.js";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { flushSync } from "react-dom";
import { AnchoredPopup } from "../feedback/AnchoredPopup.js";
import { DirectActivationButton } from "../feedback/DirectActivationButton.js";
import { MenuItemButton } from "../feedback/MenuItemButton.js";
import { AnchoredMenuDismissSignalContext, useAnchoredMenu } from "../../hooks/useAnchoredMenu.js";
import { useFacetSearchMatcher } from "../../hooks/useFacetSearchMatcher.js";
import { useImeSearchInput } from "../../hooks/useImeSearchInput.js";
import {
  facetSuggestions,
  normalizeFacetSearchQuery
} from "../../lib/ui/facet-input.js";
import { facetDisplayName } from "../../lib/ui/formatters.js";
import type { AnchoredMenuSize } from "../../lib/ui/menu-position.js";
import type { FacetOption } from "../../lib/types.js";

type FacetMode = "include" | "exclude" | "any" | "all";
const modeLabels = { include: "包含", exclude: "排除", any: "任一", all: "全部" };

function parseValue(value: string) {
  const values = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return {
    exclude: values.some((item) => item.startsWith("!")),
    selected: [...new Set(values.map((item) => item.replace(/^!/, "")))]
  };
}

export function FacetSelector({
  options,
  value,
  onChange,
  noun,
  disabled = false,
  ariaLabel,
  controlId,
  menuClassName,
  selectionMode = "include-exclude"
}: {
  selectionMode?: "include-exclude" | "any-all";
  options: FacetOption[];
  value: string;
  onChange: (value: string) => void;
  noun: string;
  disabled?: boolean;
  ariaLabel?: string;
  controlId?: string;
  menuClassName?: string;
}) {
  const resolvedAriaLabel = ariaLabel ?? noun;
  const isTag = selectionMode === "any-all";
  const tagSelection = isTag ? basicTagSelection(value) : null;
  const parsed = tagSelection ?? parseValue(value);
  const valueMode: FacetMode =
    tagSelection?.mode ?? ("exclude" in parsed && parsed.exclude ? "exclude" : "include");
  const modes: FacetMode[] = isTag ? ["any", "all"] : ["include", "exclude"];
  const dismissSignal = useContext(AnchoredMenuDismissSignalContext);
  const [selectionError, setSelectionError] = useState("");
  const [query, setQuery] = useState("");
  const searchInput = useImeSearchInput(query, setQuery);
  const [mode, setMode] = useState<FacetMode>(valueMode);
  const controlRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const collapseRef = useRef<HTMLButtonElement | null>(null);
  const menuElementRef = useRef<HTMLElement | null>(null);
  const generatedControlId = useId();
  const resolvedControlId = controlId ?? generatedControlId;
  const menuId = useId();
  const statusId = useId();
  const {
    open,
    closing,
    position,
    opensUp,
    menuRef,
    openMenu,
    requestClose,
    requestCloseAndRestoreFocus,
    onAnimationEnd
  } = useAnchoredMenu({
    triggerRef: controlRef,
    getSize: (): AnchoredMenuSize => ({
      minWidth: 300,
      maxWidth: window.innerWidth - 16,
      flipThreshold: 260,
      minAvailable: 180,
      maxHeight: 420
    }),
    initialMaxHeight: 420,
    disabled,
    onClose: () => searchInput.reset(),
    closeOnEscape: true,
    closeOnFocusOutside: true,
    focusAfterClose: () => triggerRef.current
  });
  const openSearchFromActivation = () => {
    // iOS only opens the software keyboard when focus remains inside the
    // committing user gesture. Mount the replacement input synchronously,
    // then focus it before pointerup/click returns.
    flushSync(openMenu);
    searchRef.current?.focus();
  };
  const bindMenuRef = useCallback(
    (node: HTMLElement | null) => {
      menuElementRef.current = node;
      menuRef(node);
    },
    [menuRef]
  );
  const selectedSet = new Set(parsed.selected);
  const normalizedQuery = normalizeFacetSearchQuery(query);
  const { matchName, status: pinyinStatus } = useFacetSearchMatcher(open);
  const pinyinPending = /[a-zü]/i.test(normalizedQuery) && pinyinStatus === "loading";
  const results = facetSuggestions(options, query, selectedSet, matchName);
  const searchStatus = pinyinPending
    ? "正在加载拼音搜索"
    : normalizedQuery
      ? results.length
        ? `${results.length} 个可添加的${noun}`
        : `没有可添加的${noun}`
      : `输入关键字搜索${noun}，按 Tab 浏览已选${noun}和筛选方式`;

  useEffect(() => {
    setMode(valueMode);
    setSelectionError("");
  }, [valueMode, value, dismissSignal]);

  const emitSelection = (selected: string[], nextMode = mode) => {
    try {
      const next = isTag
        ? basicTagValue(selected, nextMode === "all" ? "all" : "any")
        : selected.map((slug) => (nextMode === "exclude" ? `!${slug}` : slug)).join(",");
      setSelectionError("");
      setMode(selected.length ? nextMode : isTag ? "any" : "include");
      onChange(next);
      return true;
    } catch (error) {
      if (!(error instanceof TagFilterError)) throw error;
      setSelectionError(error.message);
      return false;
    }
  };

  const menuButtons = () =>
    Array.from(
      menuElementRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)"
      ) ?? []
    );
  const focusMenuEdge = (edge: "first" | "last") => {
    const buttons = menuButtons();
    const target = edge === "first" ? buttons[0] : buttons.at(-1);
    target?.focus();
    return Boolean(target);
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key !== "Tab" || event.shiftKey) return;
    if (focusMenuEdge("first")) event.preventDefault();
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const buttons = menuButtons();
    if (event.shiftKey && event.target === buttons[0]) {
      event.preventDefault();
      searchRef.current?.focus();
    } else if (!event.shiftKey && event.target === buttons.at(-1)) {
      event.preventDefault();
      collapseRef.current?.focus();
    }
  };
  const onCollapseKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Tab" || !event.shiftKey) return;
    if (focusMenuEdge("last")) event.preventDefault();
  };

  const menu = open ? (
    <AnchoredPopup
      popupRef={bindMenuRef}
      overlayScrollbar
      id={menuId}
      className={[
        "facet-select-menu",
        menuClassName,
        opensUp ? "opens-up" : "",
        closing ? "is-closing" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      role="region"
      aria-label={`${resolvedAriaLabel}筛选选项`}
      aria-hidden={closing}
      inert={closing}
      style={position}
      onAnimationEnd={onAnimationEnd}
      onKeyDown={onMenuKeyDown}
    >
      <div className="facet-search-results" aria-label={`待选${noun}`}>
        {!normalizedQuery && <span className="muted">输入名称、slug 或拼音搜索{noun}</span>}
        {pinyinPending && (
          <span className="muted" role="status">
            正在加载拼音搜索…
          </span>
        )}
        {pinyinStatus === "error" && (
          <span className="muted" role="status" title="仍可按名称或 slug 搜索">
            拼音加载失败，请刷新重试
          </span>
        )}
        {normalizedQuery &&
          results.map((option) => (
            <MenuItemButton
              className="facet-search-option"
              type="button"
              key={option.slug}
              pointerFocus="preserve"
              onActivate={() => {
                if (!emitSelection([...parsed.selected, option.slug])) return;
                searchInput.reset();
                searchRef.current?.focus({ preventScroll: true });
              }}
            >
              <FacetSuggestionLabel option={option} />
            </MenuItemButton>
          ))}
        {normalizedQuery && !pinyinPending && !results.length && (
          <span className="muted">没有可添加的{noun}</span>
        )}
      </div>
      <div className="facet-menu-divider" role="separator" />
      <div className="facet-selected-list" aria-label={`已选${noun}`}>
        <strong>已选{noun}</strong>
        <div>
          {parsed.selected.map((slug) => (
            <MenuItemButton
              type="button"
              key={slug}
              title={`移除 ${facetDisplayName(options, slug)}`}
              onActivate={() => emitSelection(parsed.selected.filter((item) => item !== slug))}
            >
              {facetDisplayName(options, slug)}
              <span aria-hidden="true">×</span>
            </MenuItemButton>
          ))}
          {!parsed.selected.length && (
            <span className="muted facet-selected-empty">尚未选择，默认使用全部{noun}</span>
          )}
        </div>
      </div>
      {selectionError && (
        <p className="muted" role="alert">
          {selectionError}
        </p>
      )}
      <div className="facet-mode-switch" aria-label={`${noun}筛选方式`}>
        {modes.map((nextMode) => (
          <MenuItemButton
            type="button"
            key={nextMode}
            className={mode === nextMode ? "active" : ""}
            aria-pressed={mode === nextMode}
            onActivate={() => {
              if (parsed.selected.length) emitSelection(parsed.selected, nextMode);
              else setMode(nextMode);
            }}
          >
            {mode === nextMode ? "✓ " : ""}
            {modeLabels[nextMode]}
          </MenuItemButton>
        ))}
      </div>
    </AnchoredPopup>
  ) : null;

  const label = parsed.selected.length
    ? `${modeLabels[mode]} ${parsed.selected.length} 个${noun}`
    : `全部${noun}`;
  const showSearch = open && !closing;
  return (
    <div ref={controlRef} className="select-control facet-select-control">
      {showSearch ? (
        <div className="facet-search-control">
          <input
            ref={searchRef}
            id={resolvedControlId}
            className="facet-search-input"
            type="search"
            size={1}
            {...searchInput.inputProps}
            onKeyDown={onSearchKeyDown}
            placeholder={`搜索${noun}`}
            aria-label={`搜索${resolvedAriaLabel}`}
            aria-controls={menuId}
            aria-describedby={statusId}
          />
          <span
            id={statusId}
            className="facet-search-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {searchStatus}
          </span>
          <DirectActivationButton
            ref={collapseRef}
            className="facet-search-collapse"
            type="button"
            aria-label={`收起${resolvedAriaLabel}筛选`}
            aria-controls={menuId}
            aria-expanded="true"
            title={`收起${noun}筛选`}
            onKeyDown={onCollapseKeyDown}
            onActivate={requestCloseAndRestoreFocus}
          />
        </div>
      ) : (
        <DirectActivationButton
          ref={triggerRef}
          id={resolvedControlId}
          className="select-trigger"
          type="button"
          aria-label={resolvedAriaLabel}
          aria-controls={open ? menuId : undefined}
          aria-expanded="false"
          disabled={disabled}
          onActivate={() => (open ? requestClose() : openSearchFromActivation())}
        >
          <span>{label}</span>
        </DirectActivationButton>
      )}
      {menu}
    </div>
  );
}
