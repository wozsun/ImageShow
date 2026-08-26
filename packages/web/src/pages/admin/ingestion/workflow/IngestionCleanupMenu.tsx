import { useRef, type KeyboardEvent } from "react";
import { AnchoredPopup } from "../../../../components/feedback/AnchoredPopup.js";
import { DirectActivationButton } from "../../../../components/feedback/DirectActivationButton.js";
import { MenuItemButton } from "../../../../components/feedback/MenuItemButton.js";
import { AdminIcon } from "../../../../components/icon/AdminIcon.js";
import { useAnchoredMenu } from "../../../../hooks/useAnchoredMenu.js";
import type { AnchoredMenuSize } from "../../../../lib/ui/menu-position.js";
import type {
  IngestionCleanupAction,
  IngestionCleanupActionId
} from "./ingestion-cleanup-actions.js";

const CLEANUP_MENU_SIZE: AnchoredMenuSize = {
  minWidth: 184,
  maxWidth: 240,
  align: "end",
  flipThreshold: 170,
  minAvailable: 120,
  maxHeight: 220,
};

function restoreCleanupTriggerFocus(trigger: HTMLButtonElement) {
  try {
    trigger.focus({ preventScroll: true });
  } catch {
    try {
      trigger.focus();
    } catch {
      // 所选动作仍须继续分发。
    }
  }
}

export function IngestionCleanupMenu({
  actions,
  onSelect
}: {
  actions: IngestionCleanupAction[];
  onSelect: (
    actionId: IngestionCleanupActionId,
    returnFocusTarget: HTMLButtonElement
  ) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const allDisabled = actions.every((action) => !action.enabled);
  const menu = useAnchoredMenu({
    triggerRef,
    getSize: () => CLEANUP_MENU_SIZE,
    initialMaxHeight: CLEANUP_MENU_SIZE.maxHeight,
    disabled: allDisabled,
    closeOnEscape: true,
    closeOnFocusOutside: true,
    focusOnOpen: () => itemRefs.current.find((item) => item && !item.disabled),
  });

  const choose = (action: IngestionCleanupAction) => {
    if (!action.enabled) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    // 业务选择属于当前激活，菜单退场和焦点归还不能延迟实际清理。
    menu.requestClose();
    restoreCleanupTriggerFocus(trigger);
    onSelect(action.id, trigger);
  };
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const enabledIndexes = actions.flatMap((action, actionIndex) => action.enabled ? [actionIndex] : []);
    if (!enabledIndexes.length) return;
    const currentPosition = enabledIndexes.indexOf(index);
    const nextPosition = event.key === "Home"
      ? 0
      : event.key === "End"
        ? enabledIndexes.length - 1
        : event.key === "ArrowDown"
          ? (currentPosition + 1) % enabledIndexes.length
          : (currentPosition - 1 + enabledIndexes.length) % enabledIndexes.length;
    itemRefs.current[enabledIndexes[nextPosition]]?.focus();
  };

  const popup = menu.open ? (
    <AnchoredPopup
      popupRef={menu.menuRef}
      className={`select-menu ingestion-cleanup-menu${menu.opensUp ? " opens-up" : ""}${menu.closing ? " is-closing" : ""}`}
      role="menu"
      aria-label="清理任务"
      aria-hidden={menu.closing}
      inert={menu.closing}
      style={menu.position}
      onAnimationEnd={menu.onAnimationEnd}
    >
      {actions.map((action, index) => (
        <MenuItemButton
          key={action.id}
          ref={(element) => { itemRefs.current[index] = element; }}
          type="button"
          role="menuitem"
          disabled={!action.enabled}
          onKeyDown={(event) => moveFocus(event, index)}
          onActivate={() => choose(action)}
        >
          {action.label}
        </MenuItemButton>
      ))}
    </AnchoredPopup>
  ) : null;

  return (
    <>
      <DirectActivationButton
        ref={triggerRef}
        type="button"
        className="icon pressable ingestion-cleanup-trigger"
        title="清理任务"
        aria-label="清理任务"
        aria-haspopup="menu"
        aria-expanded={menu.open && !menu.closing}
        disabled={allDisabled}
        onActivate={() => menu.open ? menu.requestClose() : menu.openMenu()}
      >
        <AdminIcon name="delete-bin-6-line" />
      </DirectActivationButton>
      {popup}
    </>
  );
}
