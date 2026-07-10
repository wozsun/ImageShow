import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useAnchoredMenu } from "../../hooks/useAnchoredMenu.js";
import type { AnchoredMenuSize } from "../../lib/ui/menu-position.js";
import type { FacetOption } from "../../lib/types.js";

type FacetMode = "include" | "exclude";

function parseValue(value: string) {
  const values = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return {
    exclude: values.some((item) => item.startsWith("!")),
    selected: [...new Set(values.map((item) => item.replace(/^!/, "")))]
  };
}

export function FacetSelector({ options, value, onChange, noun, disabled = false, ariaLabel }: {
  options: FacetOption[];
  value: string;
  onChange: (value: string) => void;
  noun: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const resolvedAriaLabel = ariaLabel ?? noun;
  const parsed = parseValue(value);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<FacetMode>(parsed.exclude ? "exclude" : "include");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const { open, closing, position, opensUp, openMenu, requestClose, onAnimationEnd } = useAnchoredMenu({
    triggerRef,
    menuRef,

    getSize: (): AnchoredMenuSize => ({ minWidth: 300, maxWidth: window.innerWidth - 16, flipThreshold: 260, minAvailable: 180, maxHeight: 420 }),
    initialMaxHeight: 420,
    disabled,
    onClose: () => setQuery(""),
    closeOnEscape: true,
    closeOnFocusOutside: true,
    focusOnOpen: () => searchRef.current
  });
  const nameFor = (slug: string) => options.find((option) => option.slug === slug)?.display_name || slug;
  const selectedSet = new Set(parsed.selected);
  const normalizedQuery = query.trim().toLowerCase();
  const results = normalizedQuery
    ? options.filter((option) => !selectedSet.has(option.slug)
      && (option.slug.includes(normalizedQuery) || option.display_name.toLowerCase().includes(normalizedQuery))).slice(0, 50)
    : [];

  useEffect(() => {
    if (parsed.selected.length) setMode(parsed.exclude ? "exclude" : "include");
  }, [parsed.exclude, value]);

  const emitSelection = (selected: string[], nextMode = mode) => {
    onChange(selected.map((slug) => nextMode === "exclude" ? `!${slug}` : slug).join(","));
  };

  const menu = open && typeof document !== "undefined" ? createPortal(
    <div
      ref={menuRef}
      className={`facet-select-menu ${opensUp ? "opens-up" : ""} ${closing ? "is-closing" : ""}`}
      role="dialog"
      aria-label={`${resolvedAriaLabel}筛选`}
      aria-hidden={closing}
      inert={closing}
      style={position}
      onAnimationEnd={onAnimationEnd}
    >
      <input
        ref={searchRef}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`搜索${noun}`}
      />
      <div className="facet-search-results" aria-label={`待选${noun}`}>
        {!normalizedQuery && <span className="muted">输入关键字搜索{noun}</span>}
        {normalizedQuery && results.map((option) => (
          <button
            className="facet-search-option"
            type="button"
            key={option.slug}
            onClick={() => emitSelection([...parsed.selected, option.slug])}
          >
            <span>{option.slug}</span>
            {option.display_name && option.display_name !== option.slug && (
              <span className="option-display-name">{option.display_name}</span>
            )}
          </button>
        ))}
        {normalizedQuery && !results.length && <span className="muted">没有可添加的{noun}</span>}
      </div>
      <div className="facet-menu-divider" role="separator" />
      <div className="facet-selected-list" aria-label={`已选${noun}`}>
        <strong>已选{noun}</strong>
        <div>
          {parsed.selected.map((slug) => (
            <button
              type="button"
              key={slug}
              title={`移除 ${nameFor(slug)}`}
              onClick={() => emitSelection(parsed.selected.filter((item) => item !== slug))}
            >
              {nameFor(slug)}<span aria-hidden="true">×</span>
            </button>
          ))}
          {!parsed.selected.length && <span className="muted">尚未选择，默认使用全部{noun}</span>}
        </div>
      </div>
      <div className="facet-mode-switch" aria-label={`${noun}筛选方式`}>
        {(["include", "exclude"] as const).map((nextMode) => (
          <button
            type="button"
            key={nextMode}
            className={mode === nextMode ? "active" : ""}
            aria-pressed={mode === nextMode}
            onClick={() => { setMode(nextMode); if (parsed.selected.length) emitSelection(parsed.selected, nextMode); }}
          >
            {mode === nextMode ? "✓ " : ""}{nextMode === "include" ? "包含" : "排除"}
          </button>
        ))}
      </div>
    </div>,
    document.body
  ) : null;

  const label = parsed.selected.length
    ? `${mode === "include" ? "包含" : "排除"} ${parsed.selected.length} 个${noun}`
    : `全部${noun}`;
  return (
    <div className="select-control facet-select-control">
      <button
        ref={triggerRef}
        className={`select-trigger ${open && !closing ? "is-open" : ""}`}
        type="button"
        aria-label={resolvedAriaLabel}
        aria-haspopup="dialog"
        aria-expanded={open && !closing}
        disabled={disabled}
        onClick={() => open ? requestClose() : openMenu()}
      >
        <span>{label}</span>
      </button>
      {menu}
    </div>
  );
}
