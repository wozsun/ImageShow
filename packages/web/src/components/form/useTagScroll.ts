import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  tagScrollAvailability,
  tagScrollContentMetrics,
  tagScrollItemMetrics,
  tagScrollNavigationTarget,
  tagVerticalWheelPixels,
  tagWheelScrollTarget,
  type TagScrollAvailability
} from "./tag-input-scroll.js";

const noTagScroll: TagScrollAvailability = {
  backward: false,
  forward: false
};

/** Shared horizontal chip navigation; editor focus and input remain with callers. */
export function useTagScroll(focusFallbackRef?: RefObject<HTMLElement | null>) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const backwardNavigationRef = useRef<HTMLButtonElement | null>(null);
  const forwardNavigationRef = useRef<HTMLButtonElement | null>(null);
  const wheelTargetRef = useRef<{ left: number; direction: number } | null>(null);
  const [scrollAvailability, setScrollAvailability] = useState(noTagScroll);
  const scrollAvailabilityRef = useRef(noTagScroll);
  const cancelPendingScroll = useCallback(() => { wheelTargetRef.current = null; }, []);

  const refreshScrollAvailability = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const next = tagScrollAvailability(box);
    const current = scrollAvailabilityRef.current;
    const unchanged = (
      current.backward === next.backward
      && current.forward === next.forward
    );
    const activeElement = box.ownerDocument.activeElement;
    const focusedNavigation = activeElement === backwardNavigationRef.current
      ? backwardNavigationRef.current
      : activeElement === forwardNavigationRef.current
        ? forwardNavigationRef.current
        : null;
    const disablingFocusedNavigation = (
      focusedNavigation !== null
      && (
        (
          focusedNavigation === backwardNavigationRef.current
          && !next.backward
        )
        || (
          focusedNavigation === forwardNavigationRef.current
          && !next.forward
        )
      )
    );
    if (disablingFocusedNavigation) {
      // Keep keyboard focus on a stable owner when an edge button disappears.
      focusFallbackRef?.current?.focus({ preventScroll: true });
    }
    if (unchanged) return;
    if (backwardNavigationRef.current) {
      backwardNavigationRef.current.disabled = !next.backward;
    }
    if (forwardNavigationRef.current) {
      forwardNavigationRef.current.disabled = !next.forward;
    }
    scrollAvailabilityRef.current = next;
    setScrollAvailability(next);
  }, [focusFallbackRef]);

  useEffect(() => {
    const control = wrapRef.current;
    const box = scrollRef.current;
    if (!control || !box) return;
    const ownerWindow = box.ownerDocument.defaultView;
    const releaseWheelTarget = () => {
      wheelTargetRef.current = null;
    };
    const onScrollEnd = () => {
      const target = wheelTargetRef.current;
      if (target !== null && Math.abs(box.scrollLeft - target.left) < 1) {
        releaseWheelTarget();
      }
    };
    const onWheel = (event: WheelEvent) => {
      const finePointer = ownerWindow?.matchMedia?.("(any-pointer: fine)")
        .matches ?? true;
      if (!finePointer) return;
      const delta = tagVerticalWheelPixels({
        clientWidth: box.clientWidth,
        deltaMode: event.deltaMode,
        deltaX: event.deltaX,
        deltaY: event.deltaY
      });
      if (delta === null) {
        releaseWheelTarget();
        return;
      }
      if (event.cancelable) event.preventDefault();
      // Native smooth scrolling has not reached scrollLeft's destination yet.
      // Accumulate same-direction samples against that destination, while a
      // reversal starts at the visible position for an immediate response.
      const pending = wheelTargetRef.current;
      const target = tagWheelScrollTarget({
        clientWidth: box.clientWidth,
        scrollWidth: box.scrollWidth,
        scrollLeft: pending?.direction === Math.sign(delta)
          ? pending.left
          : box.scrollLeft
      }, delta);
      if (target === pending?.left) return;
      wheelTargetRef.current = { left: target, direction: Math.sign(delta) };
      box.scrollLeft = target;
      refreshScrollAvailability();
    };
    control.addEventListener("wheel", onWheel, { passive: false });
    box.addEventListener("scrollend", onScrollEnd);
    const directInputEvents = ["pointerdown", "touchstart", "keydown", "input"];
    for (const type of directInputEvents) {
      control.addEventListener(type, releaseWheelTarget, { passive: true });
    }
    const resizeObserver = typeof ownerWindow?.ResizeObserver === "function"
      ? new ownerWindow.ResizeObserver(() => {
          releaseWheelTarget();
          refreshScrollAvailability();
        })
      : null;
    resizeObserver?.observe(box);
    refreshScrollAvailability();
    return () => {
      control.removeEventListener("wheel", onWheel);
      releaseWheelTarget();
      box.removeEventListener("scrollend", onScrollEnd);
      for (const type of directInputEvents) {
        control.removeEventListener(type, releaseWheelTarget);
      }
      resizeObserver?.disconnect();
    };
  }, [refreshScrollAvailability]);

  const scrollTags = (direction: -1 | 1) => {
    wheelTargetRef.current = null;
    const box = scrollRef.current;
    if (!box) return false;
    const boxRect = box.getBoundingClientRect();
    const style = box.ownerDocument.defaultView?.getComputedStyle(box);
    const paddingLeft = Number.parseFloat(style?.paddingLeft ?? "0") || 0;
    const paddingRight = Number.parseFloat(style?.paddingRight ?? "0") || 0;
    const navigationMetrics = tagScrollContentMetrics(
      box,
      paddingLeft,
      paddingRight
    );
    const contentLeft = boxRect.left + paddingLeft;
    const contentRight = boxRect.right - paddingRight;
    const backwardRect = backwardNavigationRef.current
      ?.getBoundingClientRect();
    const forwardRect = forwardNavigationRef.current
      ?.getBoundingClientRect();
    const nextScrollLeft = tagScrollNavigationTarget(
      navigationMetrics,
      [...box.querySelectorAll<HTMLElement>("[data-tag-scroll-item]")]
        .map((item) => {
          const itemRect = item.getBoundingClientRect();
          return tagScrollItemMetrics(
            boxRect.left,
            box.scrollLeft,
            itemRect,
            paddingLeft
          );
        }),
      direction,
      {
        // The whole overlaid button counts as covered, including its
        // translucent gradient edge. Reading the real overlap keeps scroll
        // behavior aligned with the control if its CSS geometry changes.
        leading: backwardRect
          ? Math.max(0, backwardRect.right - contentLeft)
          : 0,
        trailing: forwardRect
          ? Math.max(0, contentRight - forwardRect.left)
          : 0
      }
    );
    if (Math.abs(nextScrollLeft - box.scrollLeft) < 1) return false;
    box.scrollLeft = nextScrollLeft;
    refreshScrollAvailability();
    return true;
  };

  return { wrapRef, scrollRef, backwardNavigationRef, forwardNavigationRef,
    scrollAvailability, refreshScrollAvailability, cancelPendingScroll, scrollTags };
}
