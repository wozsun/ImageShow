import {
  useContext,
  type ComponentPropsWithoutRef,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { DialogPortalTargetContext } from "./DialogPortalContext.js";

type AnchoredPopupProps = Omit<
  ComponentPropsWithoutRef<"div">,
  "children" | "ref"
> & {
  popupRef: (node: HTMLElement | null) => void;
  children: ReactNode;
};

/**
 * Shared portal surface for anchored menus. Dialogs provide an in-dialog
 * target so focus and stacking stay inside the active modal; pages fall back
 * to document.body.
 */
export function AnchoredPopup({
  popupRef,
  children,
  ...props
}: AnchoredPopupProps) {
  const dialogPortalTargetRef = useContext(DialogPortalTargetContext);
  if (typeof document === "undefined") return null;
  const portalTarget = dialogPortalTargetRef?.current ?? document.body;

  return createPortal(
    <div
      ref={popupRef}
      data-dialog-portal-menu={
        dialogPortalTargetRef?.current ? "" : undefined
      }
      {...props}
    >
      {children}
    </div>,
    portalTarget
  );
}
