export const publicNavigationTopRevealThreshold = 26;
export const publicNavigationTopEdgeRevealHeight = 36;
export const publicNavigationAutoHideDelayMs = 3_000;
export const publicNavigationHeaderHideThreshold = 32;
export const publicNavigationHeaderRevealThreshold = 32;

export function isPublicNavigationInteracting(navigation: HTMLElement) {
  if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    return navigation.matches(":hover, :focus-within");
  }
  // Touch can leave sticky hover and restore focus to the filter button.
  // Only visible keyboard/input focus should keep navigation open there.
  return navigation.matches(":focus-visible")
    || navigation.querySelector(":focus-visible") !== null;
}
