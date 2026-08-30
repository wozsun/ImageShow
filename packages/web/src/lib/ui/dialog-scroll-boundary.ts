const scrollBoundaryEpsilon = 1;

type DialogScrollMetrics = Pick<
  HTMLElement,
  "clientHeight" | "scrollHeight" | "scrollTop"
>;

type DialogHorizontalScrollMetrics = Pick<
  HTMLElement,
  "clientWidth" | "scrollLeft" | "scrollWidth"
>;

/**
 * A finger moving upward asks the scroll owner to advance, while a finger
 * moving downward asks it to retreat. Once the owner reaches that directional
 * boundary the gesture must not chain back to the frozen document.
 */
export function canDialogScrollOwnerConsumeTouchMove(
  owner: DialogScrollMetrics,
  touchDeltaY: number
) {
  if (Math.abs(touchDeltaY) < scrollBoundaryEpsilon) return true;
  if (owner.scrollHeight <= owner.clientHeight + scrollBoundaryEpsilon) {
    return false;
  }
  if (touchDeltaY < 0) {
    return owner.scrollTop + owner.clientHeight
      < owner.scrollHeight - scrollBoundaryEpsilon;
  }
  return owner.scrollTop > scrollBoundaryEpsilon;
}

/**
 * A finger moving left advances the horizontal owner, while a finger moving
 * right retreats it. The caller owns boundary locking and native-event
 * cancellation so every descendant, including an input, moves this owner.
 */
export function canDialogHorizontalScrollOwnerConsumeTouchMove(
  owner: DialogHorizontalScrollMetrics,
  touchDeltaX: number
) {
  if (Math.abs(touchDeltaX) < scrollBoundaryEpsilon) return true;
  if (owner.scrollWidth <= owner.clientWidth + scrollBoundaryEpsilon) {
    return false;
  }
  if (touchDeltaX < 0) {
    return owner.scrollLeft + owner.clientWidth
      < owner.scrollWidth - scrollBoundaryEpsilon;
  }
  return owner.scrollLeft > scrollBoundaryEpsilon;
}

export function consumeDialogHorizontalTouchMove(
  owner: DialogHorizontalScrollMetrics,
  touchDeltaX: number
) {
  const maximum = Math.max(0, owner.scrollWidth - owner.clientWidth);
  const next = Math.min(
    maximum,
    Math.max(0, owner.scrollLeft - touchDeltaX)
  );
  // scrollLeft is a double. Preserve every post-intent subpixel delta instead
  // of dropping high-refresh touch samples after lastClientX has advanced.
  if (next === owner.scrollLeft) return false;
  owner.scrollLeft = next;
  return true;
}

export function dialogEventTargetElement(target: EventTarget | null) {
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

function isScrollableElement(element: HTMLElement) {
  if (
    element.scrollHeight
      <= element.clientHeight + scrollBoundaryEpsilon
  ) return false;
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  const overflowY = style?.overflowY || style?.overflow || "";
  return /^(auto|scroll|overlay)$/.test(overflowY);
}

function isDialogHorizontalScrollOwner(element: HTMLElement) {
  if (!element.hasAttribute("data-dialog-horizontal-scroll-owner")) {
    return false;
  }
  if (element.scrollWidth <= element.clientWidth + scrollBoundaryEpsilon) {
    return false;
  }
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  const overflowX = style?.overflowX || style?.overflow || "";
  return /^(auto|scroll|overlay)$/.test(overflowX);
}

export function findDialogTouchScrollOwner(
  target: EventTarget | null,
  frame: HTMLElement
) {
  let element = dialogEventTargetElement(target);
  if (!element || !frame.contains(element)) return null;
  while (element) {
    if (
      element instanceof HTMLElement
      && isScrollableElement(element)
    ) return element;
    if (element === frame) break;
    element = element.parentElement;
  }
  return null;
}

export function findDialogHorizontalTouchScrollOwner(
  target: EventTarget | null,
  frame: HTMLElement
) {
  let element = dialogEventTargetElement(target);
  if (!element || !frame.contains(element)) return null;
  while (element) {
    if (
      element instanceof HTMLElement
      && isDialogHorizontalScrollOwner(element)
    ) return element;
    if (element === frame) break;
    element = element.parentElement;
  }
  return null;
}
