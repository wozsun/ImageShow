import { cloneElement, useContext, useRef, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { DialogPortalTargetContext } from "./DialogPortalContext.js";

type DialogLayerElement = ReactElement<{
  "data-dialog-layer"?: "root" | "nested";
}>;

/**
 * Owns the coordinate system for every dialog layer. The outermost dialog is
 * portaled beside the frozen application root and follows the dynamic
 * viewport; a child dialog stays absolute within its parent dialog.
 */
export function DialogLayerPortal({ children }: { children: DialogLayerElement }) {
  const parentDialogPortalTargetRef = useContext(DialogPortalTargetContext);
  const portalTargetRef = useRef<HTMLElement | null | undefined>(undefined);
  if (portalTargetRef.current === undefined) {
    portalTargetRef.current = parentDialogPortalTargetRef
      ? parentDialogPortalTargetRef.current
      : typeof document === "undefined"
        ? null
        : document.body;
  }
  const layer = cloneElement(children, {
    "data-dialog-layer": parentDialogPortalTargetRef ? "nested" : "root"
  });
  // Freeze the destination for this mount. When parent and child dialogs open
  // together, the parent ref is still null during the child's first render and
  // the nested layer already lives inside that parent. Moving it into a Portal
  // on the first controlled-input update would remount the field and drop focus.
  return portalTargetRef.current
    ? createPortal(layer, portalTargetRef.current)
    : layer;
}
