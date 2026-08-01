import {
  useCallback,
  useContext,
  useRef,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { anchoredPopupBoundaryClass } from "../../lib/ui/anchored-popup-boundary.js";
import { localizeAnchoredPosition } from "../../lib/ui/menu-position.js";
import { OverlayScrollbar } from "../layout/OverlayScrollbar.js";
import { DialogPortalTargetContext } from "./DialogPortalContext.js";

type AnchoredPopupProps = Omit<
  ComponentPropsWithoutRef<"div">,
  "children" | "ref"
> & {
  popupRef: (node: HTMLElement | null) => void;
  children: ReactNode;
  overlayScrollbar?: boolean;
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
  overlayScrollbar = false,
  style,
  ...props
}: AnchoredPopupProps) {
  const dialogPortalTargetRef = useContext(DialogPortalTargetContext);
  const popupElementRef = useRef<HTMLElement | null>(null);
  const setPopupRef = useCallback((node: HTMLDivElement | null) => {
    popupElementRef.current = node;
    popupRef(node);
  }, [popupRef]);
  if (typeof document === "undefined") return null;
  const dialogPortalTarget = dialogPortalTargetRef?.current ?? null;
  const portalTarget = dialogPortalTarget ?? document.body;
  const portalStyle = localizePopupStyle(style, dialogPortalTarget);

  return createPortal(
    <div className={anchoredPopupBoundaryClass}>
      <div
        ref={setPopupRef}
        data-dialog-portal-menu={
          dialogPortalTarget ? "" : undefined
        }
        {...props}
        style={portalStyle}
      >
        {children}
      </div>
      {overlayScrollbar && (
        <OverlayScrollbar
          targetRef={popupElementRef}
          containerRef={dialogPortalTarget
            ? dialogPortalTargetRef ?? undefined
            : undefined}
          layer="menu"
        />
      )}
    </div>,
    portalTarget
  );
}
