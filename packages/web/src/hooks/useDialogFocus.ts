import { useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.getAttribute("aria-hidden") === "true") return false;
    if (element.closest("[inert]")) return false;
    return element.getClientRects().length > 0;
  });
}

export function useDialogFocus({
  containerRef,
  initialFocusRef,
  returnFocusRef,
  onEscape,
  active = true,
}: {
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onEscape: () => void;
  active?: boolean;
}) {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useLayoutEffect(() => {
    if (!active) return;

    const container = containerRef.current;
    if (!container) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const returnFocus = returnFocusRef?.current ?? previousFocus;

    const initialFocus = initialFocusRef?.current ?? focusableElements(container)[0] ?? container;
    initialFocus.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onEscapeRef.current();
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
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (returnFocus && returnFocus.isConnected) {
        returnFocus.focus({ preventScroll: true });
      }
    };
  }, [active, containerRef, initialFocusRef, returnFocusRef]);
}
