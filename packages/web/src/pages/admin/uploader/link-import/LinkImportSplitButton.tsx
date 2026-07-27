import { useEffect, useRef } from "react";
import { AnchoredPopup } from "../../../../components/feedback/AnchoredPopup.js";
import { DirectActivationButton } from "../../../../components/feedback/DirectActivationButton.js";
import { MenuItemButton } from "../../../../components/feedback/MenuItemButton.js";
import { Icon } from "../../../../components/icon/Icon.js";
import { useAnchoredMenu } from "../../../../hooks/useAnchoredMenu.js";
import type { AnchoredMenuSize } from "../../../../lib/ui/menu-position.js";

const IMPORT_MENU_SIZE: AnchoredMenuSize = {
  minWidth: 150,
  align: "end",
  flipThreshold: 180,
  minAvailable: 96,
  maxHeight: 240
};

export function LinkImportSplitButton({ onOpenWorkflow, onOpenUrls, onOpenJsonl, onOpenWeibo }: {
  onOpenWorkflow: (opener: HTMLButtonElement) => void;
  onOpenUrls: (opener: HTMLButtonElement) => void;
  onOpenJsonl: (opener: HTMLButtonElement) => void;
  onOpenWeibo: (opener: HTMLButtonElement) => void;
}) {
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const hoverCloseTimerRef = useRef<number | undefined>(undefined);
  const pinnedOpenRef = useRef(false);
  const selectionPendingRef = useRef(false);
  const menu = useAnchoredMenu({
    triggerRef: menuTriggerRef,
    getSize: () => IMPORT_MENU_SIZE,
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
    }, 120);
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
    <div className="link-import-split">
      <button className="button secondary upload-trigger link-import-main" type="button" onClick={(event) => onOpenWorkflow(event.currentTarget)}>
        <Icon name="download-cloud-2-line" />导入图片
      </button>
      <DirectActivationButton
        ref={menuTriggerRef}
        className="button secondary link-import-menu-trigger"
        type="button"
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
        <Icon name="arrow-down-s-line" />
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
          <MenuItemButton type="button" role="menuitem" onActivate={() => choose(onOpenUrls)}>
            <Icon name="link" />链接导入
          </MenuItemButton>
          <MenuItemButton type="button" role="menuitem" onActivate={() => choose(onOpenJsonl)}>
            <Icon name="file-list-line" />清单导入
          </MenuItemButton>
          <MenuItemButton type="button" role="menuitem" onActivate={() => choose(onOpenWeibo)}>
            <Icon name="weibo-line" />微博导入
          </MenuItemButton>
        </AnchoredPopup>
      )}
    </div>
  );
}
