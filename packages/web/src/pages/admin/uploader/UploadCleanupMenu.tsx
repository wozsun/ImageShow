import {
  useRef,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { AnchoredPopup } from "../../../components/feedback/AnchoredPopup.js";
import { Icon } from "../../../components/icon/Icon.js";
import { useAnchoredMenu } from "../../../hooks/useAnchoredMenu.js";
import type { AnchoredMenuSize } from "../../../lib/ui/menu-position.js";
import type {
  UploadCleanupAction,
  UploadCleanupActionId
} from "./upload-cleanup-actions.js";

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
    // 老 WebKit 可能不接受 FocusOptions；焦点恢复失败也不能阻断清理动作。
    try {
      trigger.focus();
    } catch {
      // 所选动作仍须继续分发。
    }
  }
}

export function UploadCleanupMenu({
  actions,
  onSelect
}: {
  actions: UploadCleanupAction[];
  onSelect: (
    actionId: UploadCleanupActionId,
    returnFocusTarget: HTMLButtonElement
  ) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pointerPressRef = useRef<{
    actionId: UploadCleanupActionId;
    pointerId: number;
  } | null>(null);
  const pointerClickGuardRef = useRef<UploadCleanupActionId | null>(null);
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

  const choose = (action: UploadCleanupAction) => {
    if (!action.enabled) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    // 清理属于本次用户激活，不能依赖退场 animationend、fallback timer 或
    // 延迟焦点回调。iOS Safari 的触摸点击与焦点时序可能让这些后续回调丢失；
    // 菜单仍正常退场，但业务选择在当前事件内固定并交给最新队列快照处理。
    menu.requestClose();
    restoreCleanupTriggerFocus(trigger);
    onSelect(action.id, trigger);
  };
  const startPointerPress = (
    event: ReactPointerEvent<HTMLButtonElement>,
    action: UploadCleanupAction
  ) => {
    if (event.pointerType === "mouse") {
      pointerPressRef.current = null;
      pointerClickGuardRef.current = null;
      return;
    }
    if (event.isPrimary === false || event.button !== 0) return;
    pointerPressRef.current = {
      actionId: action.id,
      pointerId: event.pointerId
    };
    // 即使 WebKit 在 pointerup 后仍补发兼容 click，它也不能重复执行或把
    // 已滑出/取消的触控重新解释为激活。
    pointerClickGuardRef.current = action.id;
  };
  const cancelPointerPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pointerPressRef.current?.pointerId === event.pointerId) {
      pointerPressRef.current = null;
    }
  };
  const finishPointerPress = (
    event: ReactPointerEvent<HTMLButtonElement>,
    action: UploadCleanupAction
  ) => {
    if (event.pointerType === "mouse") return;
    const press = pointerPressRef.current;
    pointerPressRef.current = null;
    if (
      event.isPrimary === false
      || event.button !== 0
      || press?.pointerId !== event.pointerId
      || press.actionId !== action.id
    ) return;

    const rect = event.currentTarget.getBoundingClientRect();
    if (
      event.clientX < rect.left
      || event.clientX > rect.right
      || event.clientY < rect.top
      || event.clientY > rect.bottom
    ) return;

    // 触控/笔的 pointerup 早于兼容 click，在菜单可能进入 inert 前固定选择。
    event.preventDefault();
    choose(action);
  };
  const chooseFromClick = (
    event: ReactMouseEvent<HTMLButtonElement>,
    action: UploadCleanupAction
  ) => {
    // 部分 WebKit 仍会在 pointerup 后补发 click；该 click 只负责去重。
    if (event.detail > 0 && pointerClickGuardRef.current === action.id) {
      pointerClickGuardRef.current = null;
      return;
    }
    pointerClickGuardRef.current = null;
    choose(action);
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
          onPointerDown={(event) => startPointerPress(event, action)}
          onPointerUp={(event) => finishPointerPress(event, action)}
          onPointerCancel={cancelPointerPress}
          onLostPointerCapture={cancelPointerPress}
          onClick={(event) => chooseFromClick(event, action)}
        >
          {action.label}
        </button>
      ))}
    </AnchoredPopup>
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
        disabled={allDisabled}
        onClick={() => {
          if (menu.open) {
            pointerPressRef.current = null;
            pointerClickGuardRef.current = null;
            menu.requestClose();
            return;
          }
          pointerPressRef.current = null;
          pointerClickGuardRef.current = null;
          menu.openMenu();
        }}
      >
        <Icon name="delete-bin-6-line" />
      </button>
      {popup}
    </>
  );
}
