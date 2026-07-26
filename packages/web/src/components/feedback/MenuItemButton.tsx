import { forwardRef } from "react";
import {
  DirectActivationButton,
  type DirectActivationButtonProps
} from "./DirectActivationButton.js";

/**
 * Shared activation boundary for items rendered in anchored menus.
 *
 * Touch and pen activation is committed on pointerup, before WebKit's delayed
 * compatibility mouse events and any focus-driven menu teardown can intervene.
 * A short-lived capture guard consumes the whole compatibility activation even
 * when activation removes the item. Mouse and keyboard keep the native click
 * path. A matching press and release inside the same item are required so
 * scrolling or sliding away never selects.
 */
export const MenuItemButton = forwardRef<
  HTMLButtonElement,
  DirectActivationButtonProps
>(function MenuItemButton({
  className = "",
  onActivate,
  preserveFocusOnPress = false,
  ...buttonProps
}, ref) {
  return (
    <DirectActivationButton
      {...buttonProps}
      ref={ref}
      className={`anchored-menu-item ${className}`.trim()}
      preserveFocusOnPress={preserveFocusOnPress}
      onActivate={onActivate}
    />
  );
});
