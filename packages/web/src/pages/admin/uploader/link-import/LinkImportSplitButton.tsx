import { useEffect, useRef } from "react";
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

export function LinkImportSplitButton({
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
    animateClose: true,
    onClose: () => {
      pinnedOpenRef.current = false;
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
    cancelHoverClose();
    if (menu.closing) {
      if (!selectionPendingRef.current) menu.cancelClose();
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
    cancelHoverClose();
    if (menu.closing) {
      if (selectionPendingRef.current) return;
      pinnedOpenRef.current = true;
      menu.cancelClose();
      return;
    }
    if (menu.open && pinnedOpenRef.current) {
      pinnedOpenRef.current = false;
      menu.requestClose();
      return;
    }
    pinnedOpenRef.current = true;
    if (!menu.open) menu.openMenu();
  };

  useEffect(() => () => {
    if (hoverCloseTimerRef.current !== undefined) {
      window.clearTimeout(hoverCloseTimerRef.current);
    }
  }, []);

  const choose = (action: (opener: HTMLButtonElement) => void) => {
    const opener = menuTriggerRef.current;
    if (!opener) return;
    selectionPendingRef.current = true;
    menu.requestClose(() => {
      selectionPendingRef.current = false;
      action(opener);
    });
  };

  return (
    <div ref={splitRef} className="link-import-split">
      <button
        className="button secondary upload-trigger link-import-main"
        type="button"
        disabled={pending}
        aria-busy={pending || undefined}
        {...preloadIntentProps(onPreloadWorkflow)}
        onClick={(event) => onOpenWorkflow(event.currentTarget)}
      >
        <AdminIcon name="download-cloud-2-line" />导入图片
      </button>
      <DirectActivationButton
        ref={menuTriggerRef}
        className="button secondary link-import-menu-trigger"
        type="button"
        disabled={pending}
        title="更多导入方式"
        aria-haspopup="menu"
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
            "link-import-menu",
            menu.opensUp ? "opens-up" : "",
            menu.closing ? "is-closing" : ""
          ].filter(Boolean).join(" ")}
          role="menu"
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
          <div className="link-import-menu-surface">
            <MenuItemButton
              type="button"
              role="menuitem"
              disabled={pending}
              onPointerEnter={onPreloadImportSource}
              onFocus={onPreloadImportSource}
              onPointerDownCapture={onPreloadImportSource}
              onActivate={() => choose(onOpenUrls)}
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
            >
              <AdminIcon name="weibo-line" />微博导入
            </MenuItemButton>
          </div>
        </AnchoredPopup>
      )}
    </div>
  );
}
