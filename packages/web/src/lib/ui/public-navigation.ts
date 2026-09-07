export const publicNavigationTopRevealThreshold = 26;
export const publicNavigationTopEdgeRevealHeight = 36;
export const publicNavigationAutoHideDelayMs = 3_000;
export const publicNavigationHeaderHideThreshold = 32;
export const publicNavigationHeaderRevealThreshold = 32;

export function isPublicNavigationInteracting(navigation: HTMLElement) {
  const activeElement = navigation.ownerDocument.activeElement;
  if (
    activeElement
    && navigation.contains(activeElement)
    && activeElement.matches('[role="textbox"][aria-readonly="true"]')
    && !activeElement.matches(":focus-visible")
  ) {
    // A pointer-selected read-only link can retain focus after its selection
    // collapses. Only an actual selection or desktop hover keeps it open.
    const selection = navigation.ownerDocument.getSelection();
    const selected = Boolean(selection && !selection.isCollapsed && (
      activeElement.contains(selection.anchorNode)
      || activeElement.contains(selection.focusNode)
    ));
    return selected || (
      window.matchMedia("(hover: hover) and (pointer: fine)").matches
      && navigation.matches(":hover")
    );
  }
  if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    return navigation.matches(":hover, :focus-within");
  }
  // Touch can leave sticky hover and restore focus to the filter button.
  // Only visible keyboard/input focus should keep navigation open there.
  return navigation.matches(":focus-visible")
    || navigation.querySelector(":focus-visible") !== null;
}
