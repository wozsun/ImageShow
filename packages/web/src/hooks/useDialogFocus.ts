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
  paused = false,
}: {
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onEscape: () => void;
  active?: boolean;
  paused?: boolean;
}) {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const returnFocusTargetRef = useRef<HTMLElement | null>(null);
  const hasActivatedRef = useRef(false);
  const wasActiveRef = useRef(false);

  const restoreFocus = () => {
    const returnFocus = returnFocusTargetRef.current;
    if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
  };

  // active 表示弹窗是否存在；paused 只暂停父级 trap，不归还焦点。Uploader 这类常驻组件
  // 关闭条件渲染的弹窗时会把 active 置为 false，因此无需卸载整个组件也能正确归还焦点。
  useLayoutEffect(() => {
    if (active && !wasActiveRef.current) {
      returnFocusTargetRef.current = returnFocusRef?.current
        ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    } else if (!active && wasActiveRef.current) {
      restoreFocus();
      returnFocusTargetRef.current = null;
      hasActivatedRef.current = false;
    }
    wasActiveRef.current = active;
  }, [active, returnFocusRef]);

  useLayoutEffect(() => () => restoreFocus(), []);

  useLayoutEffect(() => {
    if (!active || paused) return;

    const container = containerRef.current;
    if (!container) return;

    const initialFocus = initialFocusRef?.current ?? focusableElements(container)[0] ?? container;
    if (!hasActivatedRef.current || !container.contains(document.activeElement)) {
      initialFocus.focus({ preventScroll: true });
    }
    hasActivatedRef.current = true;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (event.isComposing || event.keyCode === 229) return;
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
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, paused, containerRef, initialFocusRef]);
}
