export const anchoredPopupBoundaryClass = "anchored-popup-boundary";
export const anchoredPopupBoundarySelector = `.${anchoredPopupBoundaryClass}`;

export function isWithinAnchoredPopupBoundary(
  menu: HTMLElement | null,
  target: Node
) {
  if (menu?.contains(target)) return true;
  return menu
    ?.closest(anchoredPopupBoundarySelector)
    ?.contains(target) ?? false;
}
