import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { AnchoredPopup } from "../../../../components/feedback/AnchoredPopup.js";
import { DirectActivationButton } from "../../../../components/feedback/DirectActivationButton.js";
import { MenuItemButton } from "../../../../components/feedback/MenuItemButton.js";
import { AdminIcon } from "../../../../components/icon/AdminIcon.js";
import { useAnchoredMenu } from "../../../../hooks/useAnchoredMenu.js";
import type { AnchoredMenuSize } from "../../../../lib/ui/menu-position.js";
import { preloadIntentProps } from "../../../../lib/ui/preload-intent.js";

const IMPORT_MENU_SIZE: AnchoredMenuSize = {
  minWidth: 0,
  align: "end",
  gap: 0,
  flipThreshold: 180,
  minAvailable: 96,
  maxHeight: 240
};
const DESKTOP_MENU_QUERY = "(min-width: 761px)";

export function ImportSplitButton({
  pending,
  onPreloadWorkflow,
  onPreloadImportSource,
  onOpenWorkflow,
  onOpenUrls,
  onOpenJsonl,
  onOpenWeibo
}: {
  pending: boolean;
  onPreloadWorkflow: () => void;
  onPreloadImportSource: () => void;
  onOpenWorkflow: (opener: HTMLButtonElement) => void;
  onOpenUrls: (opener: HTMLButtonElement) => void;
  onOpenJsonl: (opener: HTMLButtonElement) => void;
  onOpenWeibo: (opener: HTMLButtonElement) => void;
}) {
  const menuId = useId();
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusIndexRef = useRef<number | null>(null);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const hoverCloseTimerRef = useRef<number | undefined>(undefined);
  const pinnedOpenRef = useRef(false);
  const selectionPendingRef = useRef(false);
  const menu = useAnchoredMenu({
    triggerRef: menuTriggerRef,
    getAnchor: () => window.matchMedia(DESKTOP_MENU_QUERY).matches
      ? splitRef.current
      : menuTriggerRef.current,
    getSize: () => ({
      ...IMPORT_MENU_SIZE,
      minWidth: window.matchMedia(DESKTOP_MENU_QUERY).matches ? 0 : 150
    }),
    initialMaxHeight: IMPORT_MENU_SIZE.maxHeight,
    closeOnEscape: true,
    disabled: pending,
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
    if (pending || selectionPendingRef.current) return;
    cancelHoverClose();
    if (menu.closing) {
      menu.cancelClose();
      return;
    }
    if (!menu.open) menu.openMenu();
  };

  const closeAfterHover = () => {
    cancelHoverClose();
    if (pinnedOpenRef.current) return;
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = undefined;
      if (!pinnedOpenRef.current) menu.requestClose();
    }, 150);
  };

  const togglePinnedMenu = () => {
    if (pending || selectionPendingRef.current) return;
    cancelHoverClose();
    if (menu.closing) {
      pinnedOpenRef.current = true;
      focusIndexRef.current = 0;
      menu.cancelClose();
      return;
    }
    if (menu.open && pinnedOpenRef.current) {
      pinnedOpenRef.current = false;
      menu.requestClose();
      return;
    }
    pinnedOpenRef.current = true;
    focusIndexRef.current = 0;
    if (menu.open) itemRefs.current[0]?.focus();
    else menu.openMenu();
  };

  useEffect(() => () => {
    if (hoverCloseTimerRef.current !== undefined) {
      window.clearTimeout(hoverCloseTimerRef.current);
    }
  }, []);

  const choose = (action: (opener: HTMLButtonElement) => void) => {
    const opener = menuTriggerRef.current;
    if (!opener || pending || selectionPendingRef.current) return;
    selectionPendingRef.current = true;
    // Claim the launch transaction in the same activation turn. Waiting for
    // the menu exit animation would leave its pointer-transparent surface over
    // still-active page controls and would retain a stale activation callback.
    action(opener);
    menu.requestClose(() => {
      selectionPendingRef.current = false;
    });
  };

  const openForKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    if (pending || selectionPendingRef.current) return;
    cancelHoverClose();
    pinnedOpenRef.current = true;
    focusIndexRef.current = event.key === "ArrowUp" ? 2 : 0;
    if (menu.closing) menu.cancelClose();
    if (menu.open) itemRefs.current[focusIndexRef.current]?.focus();
    else menu.openMenu();
  };

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Tab") {
      // The popup is portalled: resume the page's Tab order at its trigger.
      menuTriggerRef.current?.focus();
      menu.requestClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? 2
      : (index + (event.key === "ArrowDown" ? 1 : 2)) % 3;
    itemRefs.current[next]?.focus();
  };

  const preloadIngestionWorkflow = () => {
    onPreloadWorkflow();
    onPreloadImportSource();
  };

  return (
    <div
      ref={splitRef}
      className="import-source-split"
      {...preloadIntentProps(preloadIngestionWorkflow)}
    >
      <button
        className="button secondary ingestion-trigger import-source-main"
        type="button"
        disabled={pending}
        aria-busy={pending || undefined}
        onClick={(event) => onOpenWorkflow(event.currentTarget)}
      >
        <AdminIcon name="download-cloud-2-line" />导入图片
      </button>
      <DirectActivationButton
        ref={menuTriggerRef}
        className="button secondary import-source-menu-trigger"
        type="button"
        disabled={pending}
        title="更多导入方式"
        aria-haspopup="menu"
        aria-controls={menu.open ? menuId : undefined}
        onKeyDown={openForKeyboard}
        aria-expanded={menu.open && !menu.closing}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") openForHover();
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") closeAfterHover();
        }}
        onActivate={togglePinnedMenu}
      >
        <AdminIcon name="arrow-down-s-line" />
      </DirectActivationButton>
      {menu.open && (
        <AnchoredPopup
          popupRef={menu.menuRef}
          className={[
            "import-source-menu",
            menu.opensUp ? "opens-up" : "",
            menu.closing ? "is-closing" : ""
          ].filter(Boolean).join(" ")}
          role="menu"
          id={menuId}
          aria-label="更多导入方式"
          aria-hidden={menu.closing}
          inert={menu.closing}
          style={menu.position}
          onAnimationEnd={menu.onAnimationEnd}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") openForHover();
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") closeAfterHover();
          }}
        >
          <div className="import-source-menu-surface">
            <MenuItemButton
              type="button"
              role="menuitem"
              disabled={pending}
              onPointerEnter={onPreloadImportSource}
              onFocus={onPreloadImportSource}
              onPointerDownCapture={onPreloadImportSource}
              onActivate={() => choose(onOpenUrls)}
              ref={(element) => { itemRefs.current[0] = element; }}
              tabIndex={-1}
              onKeyDown={(event) => moveFocus(event, 0)}
            >
              <AdminIcon name="link" />链接导入
            </MenuItemButton>
            <MenuItemButton
              type="button"
              role="menuitem"
              disabled={pending}
              onPointerEnter={onPreloadImportSource}
              onFocus={onPreloadImportSource}
              onPointerDownCapture={onPreloadImportSource}
              onActivate={() => choose(onOpenJsonl)}
              ref={(element) => { itemRefs.current[1] = element; }}
              tabIndex={-1}
              onKeyDown={(event) => moveFocus(event, 1)}
            >
              <AdminIcon name="file-list-line" />清单导入
            </MenuItemButton>
            <MenuItemButton
              type="button"
              role="menuitem"
              disabled={pending}
              onPointerEnter={onPreloadImportSource}
              onFocus={onPreloadImportSource}
              onPointerDownCapture={onPreloadImportSource}
              onActivate={() => choose(onOpenWeibo)}
              ref={(element) => { itemRefs.current[2] = element; }}
              tabIndex={-1}
              onKeyDown={(event) => moveFocus(event, 2)}
            >
              <AdminIcon name="weibo-line" />微博导入
            </MenuItemButton>
          </div>
        </AnchoredPopup>
      )}
    </div>
  );
}
