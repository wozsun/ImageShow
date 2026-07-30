import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { useLocation } from "react-router";
import { Icon } from "../icon/Icon.js";
import { useAnimatedClose } from "../../hooks/useAnimatedClose.js";
import {
  mobileViewportMediaQuery,
  useMediaQuery
} from "../../hooks/useMediaQuery.js";

export function MobileNavigation({
  children,
  className = "",
  onExpandedChange
}: {
  children: ReactNode;
  className?: string;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mobileLayout = useMediaQuery(mobileViewportMediaQuery);
  const exit = useAnimatedClose(() => setOpen(false), 160);
  const expanded = mobileLayout && open && !exit.closing;

  useEffect(() => { if (open) exit.requestClose(); }, [location.pathname]);
  useEffect(() => {
    if (!mobileLayout && open) exit.requestClose();
  }, [exit.requestClose, mobileLayout, open]);
  useLayoutEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);
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
        aria-label={expanded ? "关闭导航菜单" : "打开导航菜单"}
        aria-expanded={expanded}
        aria-controls={menuId}
        onClick={() => open ? exit.requestClose() : setOpen(true)}
      >
        <Icon name="menu-line" />导航
      </button>
      {open && (
        <nav
          id={menuId}
          className={`mobile-nav-dropdown ${exit.closing ? "is-closing" : ""}`}
          aria-hidden={exit.closing}
          inert={exit.closing}
          onAnimationEnd={exit.onAnimationEnd}
          onClick={() => exit.requestClose()}
        >
          {children}
        </nav>
      )}
    </div>
  );
}
