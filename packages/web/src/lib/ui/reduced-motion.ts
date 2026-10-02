export const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

export function reducedMotionPreferred() {
  return window.matchMedia(reducedMotionQuery).matches;
}
