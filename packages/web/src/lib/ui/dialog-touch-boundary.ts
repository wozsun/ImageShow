import {
  canDialogHorizontalScrollOwnerConsumeTouchMove,
  canDialogScrollOwnerConsumeTouchMove,
  consumeDialogHorizontalTouchMove,
  dialogEventTargetElement,
  findDialogHorizontalTouchScrollOwner,
  findDialogTouchScrollOwner
} from "./dialog-scroll-boundary.js";
import {
  classifyMovementIntent,
  type ClientPoint
} from "./movement-intent.js";

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
  origin: ClientPoint;
  lastClientX: number;
  lastClientY: number;
  horizontalOwner: HTMLElement | null;
  verticalOwner: HTMLElement | null;
  intent: "horizontal" | "vertical" | null;
  preserveNativeText: boolean;
};

/**
 * Creates the bounded capture handlers used only while at least one dialog
 * holds the page lock. This owner maps classified movement to scroll owners;
 * it does not decide descendant focus or activation. Multi-touch is left to
 * the browser for pinch zoom, and text-editing gestures keep their native path.
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
      origin: {
        clientX: touch.clientX,
        clientY: touch.clientY
      },
      lastClientX: touch.clientX,
      lastClientY: touch.clientY,
      horizontalOwner: findDialogHorizontalTouchScrollOwner(
        event.target,
        frame
      ),
      verticalOwner: findDialogTouchScrollOwner(event.target, frame),
      intent: null,
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
    const touchDeltaX = touch.clientX - activeGesture.lastClientX;
    const touchDeltaY = touch.clientY - activeGesture.lastClientY;
    activeGesture.lastClientX = touch.clientX;
    activeGesture.lastClientY = touch.clientY;

    if (!activeGesture.intent) {
      const movementIntent = classifyMovementIntent(
        activeGesture.origin,
        touch
      );
      if (!movementIntent) return;
      activeGesture.intent = activeGesture.horizontalOwner
        && movementIntent === "horizontal"
        ? "horizontal"
        : "vertical";
    }

    const currentFrame = topDialogFrame(ownerDocument);
    if (activeGesture.intent === "horizontal") {
      const owner = activeGesture.horizontalOwner;
      const staysInActiveDialog = currentFrame === activeGesture.frame
        && owner?.isConnected
        && activeGesture.frame.contains(owner);
      if (staysInActiveDialog && owner) {
        if (canDialogHorizontalScrollOwnerConsumeTouchMove(
          owner,
          touchDeltaX
        )) consumeDialogHorizontalTouchMove(owner, touchDeltaX);
      }
      // Horizontal intent is consumed explicitly so a text input, chip and
      // viewport whitespace all move the same owner without a second native
      // scroll or a chain into the frozen document at either boundary.
      if (event.cancelable) event.preventDefault();
      return;
    }

    if (
      activeGesture.preserveNativeText
      || preservesNativeTextGesture(
        event.target,
        ownerDocument,
        activeGesture.frame
      )
    ) return;

    const owner = activeGesture.verticalOwner;
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
