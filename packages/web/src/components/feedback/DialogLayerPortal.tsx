import { cloneElement, useContext, type ReactElement } from "react";
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
  const layer = cloneElement(children, {
    "data-dialog-layer": parentDialogPortalTargetRef ? "nested" : "root"
  });
  if (parentDialogPortalTargetRef || typeof document === "undefined") {
    return layer;
  }
  return createPortal(layer, document.body);
}
