const scrollBoundaryEpsilon = 1;

type DialogScrollMetrics = Pick<
  HTMLElement,
  "clientHeight" | "scrollHeight" | "scrollTop"
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
