import {
  useContext,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { localizeAnchoredPosition } from "../../lib/ui/menu-position.js";
import { DialogPortalTargetContext } from "./DialogPortalContext.js";

type AnchoredPopupProps = Omit<
  ComponentPropsWithoutRef<"div">,
  "children" | "ref"
> & {
  popupRef: (node: HTMLElement | null) => void;
  children: ReactNode;
};

function localizePopupStyle(
  style: CSSProperties | undefined,
  dialogPortalTarget: HTMLElement | null
) {
  if (!style || !dialogPortalTarget) return style;
  const rect = dialogPortalTarget.getBoundingClientRect();
  return localizeAnchoredPosition(style, {
    left: rect.left + dialogPortalTarget.clientLeft,
    top: rect.top + dialogPortalTarget.clientTop,
    scrollLeft: dialogPortalTarget.scrollLeft,
    scrollTop: dialogPortalTarget.scrollTop
  });
}

/**
 * Shared portal surface for anchored menus. Dialogs provide an in-dialog
 * target so focus and stacking stay inside the active modal; pages fall back
 * to document.body.
 */
export function AnchoredPopup({
  popupRef,
  children,
  style,
  ...props
}: AnchoredPopupProps) {
  const dialogPortalTargetRef = useContext(DialogPortalTargetContext);
  if (typeof document === "undefined") return null;
  const dialogPortalTarget = dialogPortalTargetRef?.current ?? null;
  const portalTarget = dialogPortalTarget ?? document.body;
  const portalStyle = localizePopupStyle(style, dialogPortalTarget);

  return createPortal(
    <div
      ref={popupRef}
      data-dialog-portal-menu={
        dialogPortalTarget ? "" : undefined
      }
      {...props}
      style={portalStyle}
    >
      {children}
    </div>,
    portalTarget
  );
}
