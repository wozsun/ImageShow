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
 * path. A matching press and release inside the same item without movement
 * intent are required, so scrolling never selects even when implicit pointer
 * capture keeps the moving finger over the item.
 */
export const MenuItemButton = forwardRef<
  HTMLButtonElement,
  DirectActivationButtonProps
>(function MenuItemButton({
  className = "",
  onActivate,
  ...buttonProps
}, ref) {
  return (
    <DirectActivationButton
      {...buttonProps}
      ref={ref}
      className={`anchored-menu-item ${className}`.trim()}
      onActivate={onActivate}
    />
  );
});
