import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { AnchoredPopup } from "../feedback/AnchoredPopup.js";
import { DirectActivationButton } from "../feedback/DirectActivationButton.js";
import { MenuItemButton } from "../feedback/MenuItemButton.js";
import { AdminIcon, type AdminIconName } from "../icon/AdminIcon.js";
import { useAnchoredMenu } from "../../hooks/useAnchoredMenu.js";
import { preloadIntentProps } from "../../lib/ui/preload-intent.js";
import "../../styles/admin/split-action-button.css";

export type SplitActionItem = {
  id: string;
  label: string;
  icon?: AdminIconName;
  disabled?: boolean;
  onSelect: (opener: HTMLButtonElement) => void;
  onPreload?: () => void;
};

export function SplitActionButton({
  children,
  menuLabel,
  items,
  className = "",
  mainClassName = "",
  disabled = false,
  directMain = false,
  menuTriggerRef: suppliedTriggerRef,
  onPreload,
  onActivate
}: {
  children: ReactNode;
  menuLabel: string;
  items: readonly SplitActionItem[];
  className?: string;
  mainClassName?: string;
  disabled?: boolean;
  directMain?: boolean;
  menuTriggerRef?: RefObject<HTMLButtonElement | null>;
  onPreload?: () => void;
  onActivate: (opener: HTMLButtonElement) => void;
}) {
  const menuId = useId();
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const mainRef = useRef<HTMLButtonElement | null>(null);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const ownTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuTriggerRef = suppliedTriggerRef ?? ownTriggerRef;
  const focusIndexRef = useRef<number | null>(null);
  const hoverCloseTimerRef = useRef<number | undefined>(undefined);
  const pinnedOpenRef = useRef(false);
  const selectionPendingRef = useRef(false);
  const enabledIndices = items.flatMap((item, index) => item.disabled ? [] : [index]);
  const menu = useAnchoredMenu({
    triggerRef: menuTriggerRef,
    getAnchor: () => window.matchMedia("(min-width: 761px)").matches
      ? splitRef.current
      : menuTriggerRef.current,
    getSize: () => ({
      minWidth: window.matchMedia("(min-width: 761px)").matches ? 0 : 150,
      align: "end",
      gap: 0,
      flipThreshold: 180,
      minAvailable: 96,
      maxHeight: 240
    }),
    initialMaxHeight: 240,
    closeOnEscape: true,
    disabled,
    closeOnFocusOutside: true,
    restoreFocusOnEscape: () => document.activeElement === menuTriggerRef.current
      || itemRefs.current.some((item) => item === document.activeElement),
    focusOnOpen: () => focusIndexRef.current === null ? null : itemRefs.current[focusIndexRef.current],
    animateClose: true,
    onClose: () => {
      pinnedOpenRef.current = false;
      focusIndexRef.current = null;
      if (hoverCloseTimerRef.current !== undefined) {
        window.clearTimeout(hoverCloseTimerRef.current);
        hoverCloseTimerRef.current = undefined;
      }
    }
  });

  const cancelHoverClose = () => {
    if (hoverCloseTimerRef.current === undefined) return;
    window.clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = undefined;
  };
  const openForHover = () => {
    if (disabled || selectionPendingRef.current) return;
    cancelHoverClose();
    if (menu.closing) menu.cancelClose();
    else if (!menu.open) menu.openMenu();
  };
  const closeAfterHover = () => {
    cancelHoverClose();
    if (pinnedOpenRef.current) return;
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = undefined;
      if (!pinnedOpenRef.current) menu.requestClose();
    }, 150);
  };
  const focusItem = (index: number | undefined) => {
    focusIndexRef.current = index ?? null;
    if (menu.closing) menu.cancelClose();
    if (menu.open && index !== undefined) itemRefs.current[index]?.focus();
    else menu.openMenu();
  };
  const togglePinnedMenu = () => {
    if (disabled || selectionPendingRef.current) return;
    cancelHoverClose();
    if (menu.open && !menu.closing && pinnedOpenRef.current) {
      pinnedOpenRef.current = false;
      menu.requestCloseAndRestoreFocus();
      return;
    }
    pinnedOpenRef.current = true;
    focusItem(enabledIndices[0]);
  };
  useEffect(() => () => {
    if (hoverCloseTimerRef.current !== undefined) window.clearTimeout(hoverCloseTimerRef.current);
  }, []);

  const choose = (item: SplitActionItem) => {
    const opener = menuTriggerRef.current;
    if (!opener || disabled || item.disabled || selectionPendingRef.current) return;
    selectionPendingRef.current = true;
    // The selected action claims its dialog/intent before the menu becomes
    // pointer-transparent. Never defer a launch until after the exit animation.
    try {
      item.onSelect(opener);
    } finally {
      menu.requestClose(() => {
        selectionPendingRef.current = false;
        if (document.activeElement === document.body
          && opener.isConnected && !opener.disabled && !opener.closest("[inert]")) {
          opener.focus({ preventScroll: true });
        }
      });
    }
  };
  const openForKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    if (disabled || selectionPendingRef.current) return;
    cancelHoverClose();
    pinnedOpenRef.current = true;
    focusItem(event.key === "ArrowUp" ? enabledIndices.at(-1) : enabledIndices[0]);
  };
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Tab") {
      menuTriggerRef.current?.focus();
      menu.requestClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const position = enabledIndices.indexOf(index);
    const next = event.key === "Home" ? enabledIndices[0]
      : event.key === "End" ? enabledIndices.at(-1)
      : enabledIndices[(position + (event.key === "ArrowDown" ? 1 : enabledIndices.length - 1)) % enabledIndices.length];
    if (next !== undefined) itemRefs.current[next]?.focus();
  };
  const mainProps = {
    ref: mainRef,
    className: `split-action-main ${mainClassName}`.trim(),
    type: "button" as const,
    disabled
  };
  return (
    <div ref={splitRef} className={`split-action-button ${className}`.trim()}
      {...(onPreload ? preloadIntentProps(onPreload) : {})}>
      {directMain
        ? <DirectActivationButton {...mainProps} onActivate={() => {
            if (mainRef.current) onActivate(mainRef.current);
          }}>{children}</DirectActivationButton>
        : <button {...mainProps} aria-busy={disabled || undefined}
            onClick={(event) => onActivate(event.currentTarget)}>{children}</button>}
      <DirectActivationButton
        ref={menuTriggerRef}
        className="button secondary split-action-menu-trigger"
        type="button"
        disabled={disabled}
        title={menuLabel}
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-controls={menu.open ? menuId : undefined}
        aria-expanded={menu.open && !menu.closing}
        onKeyDown={openForKeyboard}
        onPointerEnter={(event) => { if (event.pointerType === "mouse") openForHover(); }}
        onPointerLeave={(event) => { if (event.pointerType === "mouse") closeAfterHover(); }}
        onActivate={togglePinnedMenu}
      ><AdminIcon name="arrow-down-s-line" /></DirectActivationButton>
      {menu.open && (
        <AnchoredPopup
          popupRef={menu.menuRef}
          className={["split-action-menu", menu.opensUp ? "opens-up" : "", menu.closing ? "is-closing" : ""].filter(Boolean).join(" ")}
          role="menu"
          id={menuId}
          aria-label={menuLabel}
          aria-hidden={menu.closing}
          inert={menu.closing}
          style={menu.position}
          onAnimationEnd={menu.onAnimationEnd}
          onPointerEnter={(event) => { if (event.pointerType === "mouse") openForHover(); }}
          onPointerLeave={(event) => { if (event.pointerType === "mouse") closeAfterHover(); }}
        >
          <div className="split-action-menu-surface" style={{ maxHeight: Math.max(0, menu.position.maxHeight - 6) }}>
            {items.map((item, index) => (
              <MenuItemButton key={item.id} type="button" role="menuitem"
                disabled={disabled || item.disabled}
                onPointerEnter={item.onPreload}
                onFocus={item.onPreload}
                onPointerDownCapture={item.onPreload}
                onActivate={() => choose(item)}
                ref={(element) => { itemRefs.current[index] = element; }}
                tabIndex={-1}
                onKeyDown={(event) => moveFocus(event, index)}>
                {item.icon && <AdminIcon name={item.icon} />}{item.label}
              </MenuItemButton>
            ))}
          </div>
        </AnchoredPopup>
      )}
    </div>
  );
}
