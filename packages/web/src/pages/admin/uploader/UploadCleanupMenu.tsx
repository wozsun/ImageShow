import { useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../../components/icon/Icon.js";
import { useAnchoredMenu } from "../../../hooks/useAnchoredMenu.js";
import type { AnchoredMenuSize } from "../../../lib/ui/menu-position.js";

const CLEANUP_MENU_SIZE: AnchoredMenuSize = {
  minWidth: 184,
  maxWidth: 240,
  align: "end",
  flipThreshold: 170,
  minAvailable: 120,
  maxHeight: 220,
};

export type UploadCleanupAction = {
  id: string;
  label: string;
  enabled: boolean;
  run: () => void;
};

export function UploadCleanupMenu({
  disabled,
  actions,
}: {
  disabled: boolean;
  actions: UploadCleanupAction[];
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const allDisabled = actions.every((action) => !action.enabled);
  const menu = useAnchoredMenu({
    triggerRef,
    getSize: () => CLEANUP_MENU_SIZE,
    initialMaxHeight: CLEANUP_MENU_SIZE.maxHeight,
    disabled: disabled || allDisabled,
    closeOnEscape: true,
    closeOnFocusOutside: true,
    focusOnOpen: () => itemRefs.current.find((item) => item && !item.disabled),
  });

  const choose = (action: UploadCleanupAction) => {
    if (!action.enabled) return;
    menu.requestClose(action.run);
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

  const popup = menu.open && typeof document !== "undefined" ? createPortal(
    <div
      ref={menu.menuRef}
      className={`select-menu upload-cleanup-menu${menu.opensUp ? " opens-up" : ""}${menu.closing ? " is-closing" : ""}`}
      role="menu"
      aria-label="清理任务"
      aria-hidden={menu.closing}
      inert={menu.closing}
      style={menu.position}
      onAnimationEnd={menu.onAnimationEnd}
    >
      {actions.map((action, index) => (
        <button
          key={action.id}
          ref={(element) => { itemRefs.current[index] = element; }}
          type="button"
          role="menuitem"
          disabled={!action.enabled}
          onKeyDown={(event) => moveFocus(event, index)}
          onClick={() => choose(action)}
        >
          {action.label}
        </button>
      ))}
    </div>,
    document.body
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="icon pressable upload-cleanup-trigger"
        title="清理任务"
        aria-label="清理任务"
        aria-haspopup="menu"
        aria-expanded={menu.open && !menu.closing}
        disabled={disabled || allDisabled}
        onClick={() => menu.open ? menu.requestClose() : menu.openMenu()}
      >
        <Icon name="delete-bin-6-line" />
      </button>
      {popup}
    </>
  );
}
