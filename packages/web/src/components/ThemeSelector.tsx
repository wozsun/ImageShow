import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useAnchoredMenu } from "./useAnchoredMenu.js";
import type { AnchoredMenuSize } from "../lib/menu-position.js";

type ThemeMode = "include" | "exclude";

function parseValue(value: string) {
  const values = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return {
    exclude: values.some((item) => item.startsWith("!")),
    selected: [...new Set(values.map((item) => item.replace(/^!/, "")))]
  };
}

export function ThemeSelector({ themes, value, onChange, disabled = false, ariaLabel = "主题" }: {
  themes: string[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const parsed = parseValue(value);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<ThemeMode>(parsed.exclude ? "exclude" : "include");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const { open, closing, position, opensUp, openMenu, requestClose, onAnimationEnd } = useAnchoredMenu({
    triggerRef,
    menuRef,
    // maxWidth tracks the viewport so the wide menu never overflows on resize.
    getSize: (): AnchoredMenuSize => ({ minWidth: 300, maxWidth: window.innerWidth - 16, flipThreshold: 260, minAvailable: 180, maxHeight: 420 }),
    initialMaxHeight: 420,
    disabled,
    onClose: () => setQuery(""),
    closeOnEscape: true,
    closeOnFocusOutside: true,
    focusOnOpen: () => searchRef.current
  });
  const selectedSet = new Set(parsed.selected);
  const normalizedQuery = query.trim().toLowerCase();
  const results = normalizedQuery
    ? themes.filter((theme) => theme.includes(normalizedQuery) && !selectedSet.has(theme))
    : [];

  useEffect(() => {
    if (parsed.selected.length) setMode(parsed.exclude ? "exclude" : "include");
  }, [parsed.exclude, value]);

  const emit = (selected: string[], nextMode = mode) => {
    onChange(selected.map((theme) => nextMode === "exclude" ? `!${theme}` : theme).join(","));
  };

  const menu = open && typeof document !== "undefined" ? createPortal(
    <div
      ref={menuRef}
      className={`theme-select-menu ${opensUp ? "opens-up" : ""} ${closing ? "is-closing" : ""}`}
      role="dialog"
      aria-label={`${ariaLabel}筛选`}
      aria-hidden={closing}
      inert={closing}
      style={position}
      onAnimationEnd={onAnimationEnd}
    >
      <input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索主题" />
      <div className="theme-search-results" aria-label="待选主题">
        {!normalizedQuery && <span className="muted">输入关键字搜索主题</span>}
        {normalizedQuery && results.map((theme) => <button className="theme-search-option" type="button" key={theme} onClick={() => emit([...parsed.selected, theme])}>{theme}</button>)}
        {normalizedQuery && !results.length && <span className="muted">没有可添加的主题</span>}
      </div>
      <div className="theme-menu-divider" role="separator" />
      <div className="theme-selected-list" aria-label="已选主题">
        <strong>已选主题</strong>
        <div>
          {parsed.selected.map((theme) => <button type="button" key={theme} title={`移除 ${theme}`} onClick={() => emit(parsed.selected.filter((item) => item !== theme))}>{theme}<span aria-hidden="true">×</span></button>)}
          {!parsed.selected.length && <span className="muted">尚未选择，默认使用全部主题</span>}
        </div>
      </div>
      <div className="theme-mode-switch" aria-label="主题筛选方式">
        {(["include", "exclude"] as const).map((nextMode) => (
          <button
            type="button"
            key={nextMode}
            className={mode === nextMode ? "active" : ""}
            aria-pressed={mode === nextMode}
            onClick={() => { setMode(nextMode); if (parsed.selected.length) emit(parsed.selected, nextMode); }}
          >{mode === nextMode ? "✓ " : ""}{nextMode === "include" ? "包含" : "排除"}</button>
        ))}
      </div>
    </div>,
    document.body
  ) : null;

  const label = parsed.selected.length
    ? `${mode === "include" ? "包含" : "排除"} ${parsed.selected.length} 个主题`
    : "全部主题";
  return (
    <div className="select-control theme-select-control">
      <button
        ref={triggerRef}
        className={`select-trigger ${open && !closing ? "is-open" : ""}`}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open && !closing}
        disabled={disabled}
        onClick={() => open ? requestClose() : openMenu()}
      ><span>{label}</span></button>
      {menu}
    </div>
  );
}
