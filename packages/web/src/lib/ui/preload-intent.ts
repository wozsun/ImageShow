/**
 * Maps one passive preload action to the canonical intent signals used by
 * ordinary interactive elements: mouse hover, keyboard focus, and an early
 * pointer press for touch or pen activation.
 *
 * Controls that own their pointer-down activation lifecycle must keep their
 * capture-phase preload binding local instead of using this helper.
 */
export function preloadIntentProps(preload?: () => void) {
  return {
    onPointerEnter: preload,
    onFocus: preload,
    onPointerDown: preload
  };
}
