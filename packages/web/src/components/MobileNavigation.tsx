import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Icon } from "./Icon.js";
import { useAnimatedClose } from "./useAnimatedClose.js";

export function MobileNavigation({ children, className = "" }: { children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const exit = useAnimatedClose(() => setOpen(false), 160);

  useEffect(() => { if (open) exit.requestClose(); }, [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) exit.requestClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") exit.requestClose();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`mobile-navigation ${className}`.trim()}>
      <button
        className="mobile-nav-toggle"
        type="button"
        aria-label={open && !exit.closing ? "关闭导航菜单" : "打开导航菜单"}
        aria-expanded={open && !exit.closing}
        aria-controls={menuId}
        onClick={() => open ? exit.requestClose() : setOpen(true)}
      >
        <Icon name="menu-line" />导航
      </button>
      {open && <nav id={menuId} className={`mobile-nav-dropdown ${exit.closing ? "is-closing" : ""}`} aria-hidden={exit.closing} inert={exit.closing} onAnimationEnd={exit.onAnimationEnd} onClick={() => exit.requestClose()}>{children}</nav>}
    </div>
  );
}
