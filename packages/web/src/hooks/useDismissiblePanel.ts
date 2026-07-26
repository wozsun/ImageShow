import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { isDocumentFallbackFocusTarget } from "../lib/ui/focus-target.js";

const outsideInteractionEvents = [
  "pointerdown",
  "touchstart",
  "click",
  "focusin",
  "wheel"
] as const;

const defaultPortalSelector =
  ".select-menu, .facet-select-menu, [data-dialog-portal-menu]";
const scrollSequenceIdleMs = 120;
const availableHeightProperty =
  "--dismissible-panel-available-height";
const editableElementSelector =
  'input, textarea, [contenteditable]:not([contenteditable="false"])';

type TransientPanelCloseOptions = {
  restoreFocus?: boolean;
};

/**
 * Shared accessibility state and focus cleanup for mobile-only panels.
 *
 * Closing callers run prepareForClose before changing state so React can add
 * inert/aria-hidden without leaving focus in the subtree being hidden.
 */
function useTransientPanelSemantics({
  open,
  transient
}: {
  open: boolean;
  transient: boolean;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [transientStateReady, setTransientStateReady] = useState(transient);

  const prepareForClose = useCallback(({
    restoreFocus = false
  }: TransientPanelCloseOptions = {}) => {
    if (!transient || typeof document === "undefined") return;

    const panel = panelRef.current;
    const activeElement = document.activeElement;
    if (restoreFocus) {
      const trigger = triggerRef.current;
      trigger?.focus();
      if (trigger && document.activeElement === trigger) return;
    }
    if (
      panel
      && activeElement instanceof HTMLElement
      && panel.contains(activeElement)
    ) {
      activeElement.blur();
    }
  }, [transient]);

  useLayoutEffect(() => {
    if (transientStateReady === transient) return;
    // 桌面常驻面板切为移动浮层时，先在仍暴露的这一帧清理现有焦点，
    // 再于同步重渲染中添加 inert/aria-hidden。
    if (transient && !open) prepareForClose();
    setTransientStateReady(transient);
  }, [open, prepareForClose, transient, transientStateReady]);

  const panelHidden =
    transient && transientStateReady && !open ? true : undefined;

  return {
    panelHidden,
    panelRef,
    prepareForClose,
    triggerRef
  };
}

function isWithinPanelSurface(
  panel: HTMLElement,
  trigger: HTMLElement,
  event: Pick<Event, "composedPath" | "target">,
  portalSelector: string
) {
  const path = event.composedPath?.() ?? (event.target ? [event.target] : []);
  return path.some((entry) => {
    if (entry === panel || entry === trigger) return true;
    if (
      typeof Node !== "undefined"
      && entry instanceof Node
      && (panel.contains(entry) || trigger.contains(entry))
    ) {
      return true;
    }

    const matches = (entry as Partial<Element>).matches;
    return typeof matches === "function"
      && matches.call(entry, portalSelector);
  });
}

function isElementWithinPanelSurface(
  panel: HTMLElement,
  trigger: HTMLElement,
  element: Element,
  portalSelector: string
) {
  return panel.contains(element)
    || trigger.contains(element)
    || Boolean(element.closest(portalSelector));
}

function isEditingWithinPanelSurface(
  panel: HTMLElement,
  trigger: HTMLElement,
  portalSelector: string
) {
  const activeElement = panel.ownerDocument.activeElement;
  return activeElement instanceof HTMLElement
    && activeElement.matches(editableElementSelector)
    && isElementWithinPanelSurface(
      panel,
      trigger,
      activeElement,
      portalSelector
    );
}

/**
 * Shared disclosure behavior for transient filter/default panels.
 *
 * Pointer, focus and wheel interactions outside the panel close it while
 * anchored Portal menus remain part of the panel's interactive surface.
 * Filter surfaces can also opt into result-scroll dismissal. Opening the panel
 * claims any already-running scroll sequence; a later external gesture or a
 * new raw scroll sequence still dismisses it.
 */
export function useDismissiblePanel({
  open,
  onOpenChange,
  enabled = true,
  dismissOnOutsideScroll = false,
  resetKey,
  portalSelector = defaultPortalSelector
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled?: boolean;
  dismissOnOutsideScroll?: boolean;
  resetKey?: unknown;
  portalSelector?: string;
}) {
  const openRef = useRef(open);
  const onOpenChangeRef = useRef(onOpenChange);
  const motionTimerRef = useRef<number | undefined>(undefined);
  const [motionEnabled, setMotionEnabled] = useState(false);
  const [menuDismissSignal, setMenuDismissSignal] = useState(0);
  const semantics = useTransientPanelSemantics({
    open,
    transient: enabled
  });
  openRef.current = open;
  onOpenChangeRef.current = onOpenChange;

  const setOpen = useCallback((
    nextOpen: boolean,
    closeOptions?: TransientPanelCloseOptions
  ) => {
    window.clearTimeout(motionTimerRef.current);
    if (!nextOpen) {
      semantics.prepareForClose(closeOptions);
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
  }, [enabled, semantics.prepareForClose]);

  useLayoutEffect(() => {
    window.clearTimeout(motionTimerRef.current);
    setMenuDismissSignal((current) => current + 1);
    setMotionEnabled(false);
    if (openRef.current) {
      semantics.prepareForClose();
      onOpenChangeRef.current(false);
    }
  }, [resetKey, semantics.prepareForClose]);

  useEffect(() => () => {
    window.clearTimeout(motionTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    const panel = semantics.panelRef.current;
    const trigger = semantics.triggerRef.current;
    if (!enabled || !open || !panel || !trigger) return;

    let frame: number | undefined;
    const updateAvailableHeight = () => {
      frame = undefined;
      const visualViewport = window.visualViewport;
      const viewportBottom = visualViewport
        ? visualViewport.offsetTop + visualViewport.height
        : window.innerHeight;
      const availableHeight = Math.max(
        0,
        viewportBottom - trigger.getBoundingClientRect().bottom
      );
      panel.style.setProperty(
        availableHeightProperty,
        `${availableHeight}px`
      );
    };
    const scheduleUpdate = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(updateAvailableHeight);
    };

    updateAvailableHeight();
    window.addEventListener("resize", scheduleUpdate);
    window.visualViewport?.addEventListener("resize", scheduleUpdate);
    window.visualViewport?.addEventListener("scroll", scheduleUpdate);
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(trigger);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleUpdate);
      window.visualViewport?.removeEventListener("resize", scheduleUpdate);
      window.visualViewport?.removeEventListener("scroll", scheduleUpdate);
      resizeObserver.disconnect();
    };
  }, [enabled, open, semantics.panelRef, semantics.triggerRef]);

  useEffect(() => {
    const panel = semantics.panelRef.current;
    const trigger = semantics.triggerRef.current;
    if (!enabled || !open || !panel || !trigger) return;

    let ownedScrollSequenceActive = dismissOnOutsideScroll;
    let ownedScrollSequenceTimer: number | undefined;
    const finishOwnedScrollSequence = () => {
      ownedScrollSequenceActive = false;
      ownedScrollSequenceTimer = undefined;
    };
    const ownScrollSequence = () => {
      if (!dismissOnOutsideScroll) return;
      ownedScrollSequenceActive = true;
      window.clearTimeout(ownedScrollSequenceTimer);
      ownedScrollSequenceTimer = window.setTimeout(
        finishOwnedScrollSequence,
        scrollSequenceIdleMs
      );
    };
    ownScrollSequence();
    const closeOnOutsideInteraction = (event: Event) => {
      if (isWithinPanelSurface(panel, trigger, event, portalSelector)) {
        ownScrollSequence();
        return;
      }
      if (
        event.type === "focusin"
        && isDocumentFallbackFocusTarget(
          panel.ownerDocument,
          event.target
        )
      ) {
        // iOS can move focus to body/html while dismissing the keyboard.
        // The following viewport scroll still belongs to that internal edit;
        // a later physical touch outside is handled independently below.
        ownScrollSequence();
        return;
      }
      setOpen(false);
    };
    const ownInternalFocusTransition = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement
        && target.matches(editableElementSelector)
        && isElementWithinPanelSurface(
          panel,
          trigger,
          target,
          portalSelector
        )
      ) {
        ownScrollSequence();
      }
    };
    const closeOnOutsideScroll = (event: Event) => {
      if (
        isWithinPanelSurface(panel, trigger, event, portalSelector)
        || isEditingWithinPanelSurface(panel, trigger, portalSelector)
      ) {
        ownScrollSequence();
        return;
      }

      // Opening claims an already-running momentum sequence. Internal edits,
      // Portal choices and virtual-keyboard viewport changes claim their own
      // resulting scroll sequence as well. Raw scroll events keep that claim
      // alive until idle; any new outside touch/pointer/wheel closes earlier
      // in capture instead of being mistaken for the claimed tail.
      if (ownedScrollSequenceActive) {
        ownScrollSequence();
        return;
      }
      setOpen(false);
    };
    const closeOnOutsideElementScroll = (event: Event) => {
      // 页面滚动由 window 监听；这里只处理后台列表等独立滚动容器。
      if (
        event.target === document
        || event.target === document.documentElement
        || event.target === document.body
      ) return;
      closeOnOutsideScroll(event);
    };
    // touchstart covers iOS scroll gestures whose pointerdown is delayed or
    // omitted. Pointer/wheel/click/focus retain mouse, keyboard and assistive
    // input semantics.
    for (const eventName of outsideInteractionEvents) {
      document.addEventListener(
        eventName,
        closeOnOutsideInteraction,
        eventName === "touchstart"
          ? { capture: true, passive: true }
          : true
      );
    }
    if (dismissOnOutsideScroll) {
      document.addEventListener(
        "focusout",
        ownInternalFocusTransition,
        true
      );
      document.addEventListener("scroll", closeOnOutsideElementScroll, {
        capture: true,
        passive: true
      });
      window.addEventListener("scroll", closeOnOutsideScroll, {
        passive: true
      });
      window.addEventListener("resize", ownScrollSequence);
      window.visualViewport?.addEventListener(
        "resize",
        ownScrollSequence
      );
      window.visualViewport?.addEventListener(
        "scroll",
        ownScrollSequence
      );
    }
    return () => {
      window.clearTimeout(ownedScrollSequenceTimer);
      for (const eventName of outsideInteractionEvents) {
        document.removeEventListener(eventName, closeOnOutsideInteraction, true);
      }
      if (dismissOnOutsideScroll) {
        document.removeEventListener(
          "focusout",
          ownInternalFocusTransition,
          true
        );
        document.removeEventListener(
          "scroll",
          closeOnOutsideElementScroll,
          true
        );
        window.removeEventListener("scroll", closeOnOutsideScroll);
        window.removeEventListener("resize", ownScrollSequence);
        window.visualViewport?.removeEventListener(
          "resize",
          ownScrollSequence
        );
        window.visualViewport?.removeEventListener(
          "scroll",
          ownScrollSequence
        );
      }
    };
  }, [
    dismissOnOutsideScroll,
    enabled,
    open,
    portalSelector,
    setOpen
  ]);

  return {
    panelHidden: semantics.panelHidden,
    panelRef: semantics.panelRef,
    motionEnabled,
    menuDismissSignal,
    setOpen,
    triggerRef: semantics.triggerRef
  };
}
