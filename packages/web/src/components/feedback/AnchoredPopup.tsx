import {
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { anchoredPopupBoundaryClass } from "../../lib/ui/anchored-popup-boundary.js";
import {
  fixedPositionFromViewport,
  localizeAnchoredPosition
} from "../../lib/ui/menu-position.js";
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
  dialogPortalTarget: HTMLElement | null,
  fixedOrigin: { left: number; top: number }
) {
  if (!style) return style;
  if (!dialogPortalTarget) {
    return fixedPositionFromViewport(style, fixedOrigin);
  }
  const rect = dialogPortalTarget.getBoundingClientRect();
  return localizeAnchoredPosition(style, {
    left: rect.left + dialogPortalTarget.clientLeft,
    top: rect.top + dialogPortalTarget.clientTop,
    scrollLeft: dialogPortalTarget.scrollLeft,
    scrollTop: dialogPortalTarget.scrollTop
  });
}

const fixedOriginProbeStyle: CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  width: 0,
  height: 0,
  margin: 0,
  padding: 0,
  border: 0,
  visibility: "hidden",
  pointerEvents: "none"
};

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
  const fixedOriginProbeRef = useRef<HTMLSpanElement | null>(null);
  const [fixedOrigin, setFixedOrigin] = useState({ left: 0, top: 0 });
  const setPopupRef = useCallback((node: HTMLDivElement | null) => {
    popupElementRef.current = node;
    popupRef(node);
  }, [popupRef]);
  const dialogPortalTarget = typeof document === "undefined"
    ? null
    : dialogPortalTargetRef?.current ?? null;

  useLayoutEffect(() => {
    if (dialogPortalTarget) return;
    const probe = fixedOriginProbeRef.current;
    if (!probe) return;
    const rect = probe.getBoundingClientRect();
    const left = Number.isFinite(rect.left) ? rect.left : 0;
    const top = Number.isFinite(rect.top) ? rect.top : 0;
    setFixedOrigin((current) => (
      current.left === left && current.top === top
        ? current
        : { left, top }
    ));
  }, [dialogPortalTarget, style]);

  if (typeof document === "undefined") return null;
  const portalTarget = dialogPortalTarget ?? document.body;
  const portalStyle = localizePopupStyle(
    style,
    dialogPortalTarget,
    fixedOrigin
  );

  return createPortal(
    <div className={anchoredPopupBoundaryClass}>
      {!dialogPortalTarget && (
        <span
          ref={fixedOriginProbeRef}
          data-anchored-fixed-origin=""
          aria-hidden="true"
          style={fixedOriginProbeStyle}
        />
      )}
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
