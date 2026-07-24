import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";

const outsideInteractionEvents = [
  "pointerdown",
  "click",
  "focusin",
  "wheel"
] as const;

const defaultPortalSelector =
  ".select-menu, .facet-select-menu, [data-dialog-portal-menu]";

function isWithinPanelSurface(
  root: HTMLElement,
  event: Pick<Event, "composedPath" | "target">,
  portalSelector: string
) {
  const path = event.composedPath?.() ?? (event.target ? [event.target] : []);
  return path.some((entry) => {
    if (entry === root) return true;
    if (
      typeof Node !== "undefined"
      && entry instanceof Node
      && root.contains(entry)
    ) return true;

    const matches = (entry as Partial<Element>).matches;
    return typeof matches === "function"
      && matches.call(entry, portalSelector);
  });
}

/**
 * Shared disclosure behavior for transient filter/default panels.
 *
 * Pointer, focus and wheel interactions outside the panel close it while
 * anchored Portal menus remain part of the panel's interactive surface.
 */
export function useDismissiblePanel({
  open,
  onOpenChange,
  enabled = true,
  resetKey,
  portalSelector = defaultPortalSelector
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled?: boolean;
  resetKey?: unknown;
  portalSelector?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const openRef = useRef(open);
  const onOpenChangeRef = useRef(onOpenChange);
  const motionTimerRef = useRef<number | undefined>(undefined);
  const [motionEnabled, setMotionEnabled] = useState(false);
  const [menuDismissSignal, setMenuDismissSignal] = useState(0);
  openRef.current = open;
  onOpenChangeRef.current = onOpenChange;

  const setOpen = useCallback((nextOpen: boolean) => {
    window.clearTimeout(motionTimerRef.current);
    if (!nextOpen) {
      setMenuDismissSignal((current) => current + 1);
    }
    setMotionEnabled(enabled);
    onOpenChangeRef.current(nextOpen);
    if (enabled) {
      // 动画只覆盖用户触发的本次开合，避免之后跨越响应式断点时误播。
      motionTimerRef.current = window.setTimeout(
        () => setMotionEnabled(false),
        100
      );
    }
  }, [enabled]);

  useLayoutEffect(() => {
    window.clearTimeout(motionTimerRef.current);
    setMenuDismissSignal((current) => current + 1);
    setMotionEnabled(false);
    if (openRef.current) onOpenChangeRef.current(false);
  }, [resetKey]);

  useEffect(() => () => {
    window.clearTimeout(motionTimerRef.current);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !open || !root) return;

    const closeOnOutsideInteraction = (event: Event) => {
      if (isWithinPanelSurface(root, event, portalSelector)) return;
      setOpen(false);
    };
    // pointerdown 覆盖触控与滚动条拖动，wheel 覆盖鼠标滚动；不监听结果性的
    // scroll，避免移动键盘、视口重排或程序性滚动误关。
    for (const eventName of outsideInteractionEvents) {
      document.addEventListener(eventName, closeOnOutsideInteraction, true);
    }
    return () => {
      for (const eventName of outsideInteractionEvents) {
        document.removeEventListener(eventName, closeOnOutsideInteraction, true);
      }
    };
  }, [enabled, open, portalSelector, setOpen]);

  return {
    rootRef,
    motionEnabled,
    menuDismissSignal,
    setOpen
  };
}
