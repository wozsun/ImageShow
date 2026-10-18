import { useContext, useEffectEvent, useLayoutEffect, useRef, type RefObject } from "react";
import { getPageScrollLockFocusTarget } from "./usePageScrollLock.js";
import { topDialogFrame } from "../lib/ui/dialog-layer.js";
import { InteractionSurfaceContext } from "../lib/ui/interaction-surface.js";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => {
      if (element.getAttribute("aria-hidden") === "true") return false;
      if (element.closest("[inert]")) return false;
      return element.getClientRects().length > 0;
    }
  );
}

export function useDialogFocus({
  containerRef,
  initialFocusRef,
  returnFocusRef,
  onEscape,
  paused = false
}: {
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onEscape: () => void;
  paused?: boolean;
}) {
  const handleEscape = useEffectEvent(onEscape);
  const interactionSurface = useContext(InteractionSurfaceContext);
  const returnFocusTargetRef = useRef<HTMLElement | null>(null);
  const hasActivatedRef = useRef(false);

  const restoreFocus = useEffectEvent(() => {
    const returnFocus = [
      returnFocusRef?.current,
      returnFocusTargetRef.current,
      interactionSurface?.returnFocusRef.current
    ].find(
      (target) =>
        target?.isConnected &&
        !target.closest("[inert]") &&
        !target.matches(":disabled") &&
        target.getClientRects().length > 0
    );
    returnFocus?.focus({ preventScroll: true });
  });

  // 挂载即弹窗存在，卸载时归还焦点；paused 只暂停父级 trap，不归还焦点。
  useLayoutEffect(() => {
    const activeElement =
      document.activeElement instanceof HTMLElement
        && document.activeElement !== document.body
        ? document.activeElement
        : null;
    returnFocusTargetRef.current =
      returnFocusRef?.current
        ?? activeElement
        ?? getPageScrollLockFocusTarget();
    return () => restoreFocus();
  }, []);

  useLayoutEffect(() => {
    if (paused) return;

    const container = containerRef.current;
    if (!container) return;

    const initialFocus = initialFocusRef?.current ?? focusableElements(container)[0] ?? container;
    if (!hasActivatedRef.current || !container.contains(document.activeElement)) {
      initialFocus.focus({ preventScroll: true });
    }
    hasActivatedRef.current = true;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || topDialogFrame(document) !== container) return;
      if (event.key === "Escape") {
        if (event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        event.stopPropagation();
        handleEscape();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements(container);
      const firstFocusable = focusable[0] ?? container;
      const lastFocusable = focusable.at(-1) ?? container;
      const activeElement = document.activeElement;
      const focusIsOutside = !(activeElement instanceof Node) || !container.contains(activeElement);

      if (event.shiftKey && (focusIsOutside || activeElement === firstFocusable)) {
        event.preventDefault();
        lastFocusable.focus({ preventScroll: true });
        return;
      }
      if (!event.shiftKey && (focusIsOutside || activeElement === lastFocusable)) {
        event.preventDefault();
        firstFocusable.focus({ preventScroll: true });
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [paused, containerRef, initialFocusRef]);
}
