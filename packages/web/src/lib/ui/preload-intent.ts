import {
  useCallback,
  useEffect,
  useRef,
  type PointerEventHandler
} from "react";

export type PreloadIntentPolicy =
  | { hover: "immediate" }
  | { hover: "dwell"; delayMs: number }
  | { hover: "none" };

const immediatePreloadIntentPolicy = { hover: "immediate" } as const;

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

/**
 * Stateful intent bindings for expensive capabilities whose desktop hover
 * policy must be explicit. Focus and pointer press always preload immediately;
 * dwell only applies to a real fine-pointer hover.
 */
export function usePreloadIntentProps(
  preload?: () => void,
  policy: PreloadIntentPolicy = immediatePreloadIntentPolicy
) {
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHoverIntent = useCallback(() => {
    if (hoverTimeoutRef.current === null) return;
    clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = null;
  }, []);

  useEffect(() => clearHoverIntent, [clearHoverIntent, policy, preload]);

  const onPointerEnter = useCallback<PointerEventHandler<HTMLElement>>((event) => {
    if (!preload || event.pointerType !== "mouse" || policy.hover === "none") {
      return;
    }
    clearHoverIntent();
    if (policy.hover === "immediate") {
      preload();
      return;
    }
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      return;
    }
    hoverTimeoutRef.current = setTimeout(() => {
      hoverTimeoutRef.current = null;
      preload();
    }, policy.delayMs);
  }, [clearHoverIntent, policy, preload]);

  const preloadImmediately = useCallback(() => {
    clearHoverIntent();
    preload?.();
  }, [clearHoverIntent, preload]);

  return {
    onPointerEnter,
    onPointerLeave: clearHoverIntent,
    onPointerCancel: clearHoverIntent,
    onFocus: preloadImmediately,
    onPointerDown: preloadImmediately
  };
}
