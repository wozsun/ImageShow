import {
  canDialogScrollOwnerConsumeTouchMove,
  dialogEventTargetElement,
  findDialogTouchScrollOwner
} from "./dialog-scroll-boundary.js";

function topDialogFrame(ownerDocument: Document) {
  const frames = ownerDocument.querySelectorAll<HTMLElement>(
    "[data-dialog-frame]"
  );
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (
      frame?.isConnected
      && frame.getAttribute("aria-hidden") !== "true"
      && !frame.inert
    ) return frame;
  }
  return null;
}

function preservesNativeTextGesture(
  target: EventTarget | null,
  ownerDocument: Document,
  frame: HTMLElement
) {
  const element = dialogEventTargetElement(target);
  if (!element || !frame.contains(element)) return false;
  if (element?.closest(
    "input, textarea, select, option, "
      + "[contenteditable]:not([contenteditable='false'])"
  )) return true;
  const selection = ownerDocument.getSelection?.();
  if (!selection || selection.isCollapsed) return false;
  return Boolean(
    selection.anchorNode && frame.contains(selection.anchorNode)
    || selection.focusNode && frame.contains(selection.focusNode)
  );
}

function touchWithIdentifier(
  touches: TouchList,
  identifier: number
) {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index);
    if (touch?.identifier === identifier) return touch;
  }
  return null;
}

type ActiveTouchGesture = {
  frame: HTMLElement;
  identifier: number;
  lastClientY: number;
  owner: HTMLElement | null;
  preserveNativeText: boolean;
};

/**
 * Creates the bounded capture handlers used only while at least one dialog
 * holds the page lock. Multi-touch is deliberately left to the browser for
 * pinch zoom, and text-editing gestures keep their native path.
 */
export function createDialogTouchBoundary(ownerDocument: Document) {
  let activeGesture: ActiveTouchGesture | null = null;

  const reset = () => {
    activeGesture = null;
  };
  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      reset();
      return;
    }
    const frame = topDialogFrame(ownerDocument);
    const touch = event.touches.item(0);
    if (!frame || !touch) {
      reset();
      return;
    }
    activeGesture = {
      frame,
      identifier: touch.identifier,
      lastClientY: touch.clientY,
      owner: findDialogTouchScrollOwner(event.target, frame),
      preserveNativeText: preservesNativeTextGesture(
        event.target,
        ownerDocument,
        frame
      )
    };
  };
  const onTouchMove = (event: TouchEvent) => {
    if (event.touches.length !== 1 || !activeGesture) {
      reset();
      return;
    }
    const touch = touchWithIdentifier(
      event.touches,
      activeGesture.identifier
    );
    if (!touch) {
      reset();
      return;
    }
    const touchDeltaY = touch.clientY - activeGesture.lastClientY;
    activeGesture.lastClientY = touch.clientY;
    if (
      activeGesture.preserveNativeText
      || preservesNativeTextGesture(
        event.target,
        ownerDocument,
        activeGesture.frame
      )
    ) return;

    const currentFrame = topDialogFrame(ownerDocument);
    const owner = activeGesture.owner;
    const staysInActiveDialog = currentFrame === activeGesture.frame
      && owner?.isConnected
      && activeGesture.frame.contains(owner);
    if (
      staysInActiveDialog
      && canDialogScrollOwnerConsumeTouchMove(owner, touchDeltaY)
    ) return;
    if (event.cancelable) event.preventDefault();
  };
  const onTouchEnd = (event: TouchEvent) => {
    if (
      !activeGesture
      || !touchWithIdentifier(event.touches, activeGesture.identifier)
    ) reset();
  };

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    reset
  };
}
