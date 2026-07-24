import { useRef } from "react";
import { AnchoredPopup } from "../../../../components/feedback/AnchoredPopup.js";
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
  const menu = useAnchoredMenu({
    triggerRef: menuTriggerRef,
    getSize: () => IMPORT_MENU_SIZE,
    initialMaxHeight: IMPORT_MENU_SIZE.maxHeight,
    closeOnEscape: true,
    animateClose: false
  });

  const choose = (
    action: (opener: HTMLButtonElement) => void,
    fallback: HTMLButtonElement
  ) => {
    menu.requestClose(() => action(menuTriggerRef.current ?? fallback));
  };

  return (
    <div className="link-import-split">
      <button className="button secondary upload-trigger link-import-main" type="button" onClick={(event) => onOpenWorkflow(event.currentTarget)}>
        <Icon name="download-cloud-2-line" />导入图片
      </button>
      <button ref={menuTriggerRef} className="button secondary link-import-menu-trigger" type="button" title="更多导入方式" aria-haspopup="menu" aria-expanded={menu.open} onClick={() => menu.open ? menu.requestClose() : menu.openMenu()}>
        <Icon name="arrow-down-s-line" />
      </button>
      {menu.open && (
        <AnchoredPopup
          popupRef={menu.menuRef}
          className="link-import-menu"
          role="menu"
          aria-label="更多导入方式"
          style={menu.position}
        >
          <button type="button" role="menuitem" onClick={(event) => choose(onOpenUrls, event.currentTarget)}>
            <Icon name="link" />链接导入
          </button>
          <button type="button" role="menuitem" onClick={(event) => choose(onOpenJsonl, event.currentTarget)}>
            <Icon name="file-list-line" />清单导入
          </button>
          <button type="button" role="menuitem" onClick={(event) => choose(onOpenWeibo, event.currentTarget)}>
            <Icon name="weibo-line" />微博导入
          </button>
        </AnchoredPopup>
      )}
    </div>
  );
}
