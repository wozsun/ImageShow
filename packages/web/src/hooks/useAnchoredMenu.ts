import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useAnimatedClose } from "./useAnimatedClose.js";
import { computeAnchoredPosition, type AnchoredMenuSize, type MenuPosition } from "../lib/ui/menu-position.js";

export function useAnchoredMenu(options: {
  triggerRef: RefObject<HTMLElement | null>;
  menuRef: RefObject<HTMLElement | null>;
  getSize: () => AnchoredMenuSize;
  initialMaxHeight: number;
  disabled?: boolean;
  onClose?: () => void;
  closeOnEscape?: boolean;
  closeOnFocusOutside?: boolean;
  focusOnOpen?: () => HTMLElement | null | undefined;
}) {
  const { triggerRef, menuRef, disabled = false, closeOnEscape = false, closeOnFocusOutside = false } = options;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition>({ left: 0, top: 0, bottom: "auto", width: 0, maxHeight: options.initialMaxHeight });

  const getSizeRef = useRef(options.getSize); getSizeRef.current = options.getSize;
  const onCloseRef = useRef(options.onClose); onCloseRef.current = options.onClose;
  const focusOnOpenRef = useRef(options.focusOnOpen); focusOnOpenRef.current = options.focusOnOpen;

  const { closing, requestClose: animRequestClose, onAnimationEnd } = useAnimatedClose(() => {
    setOpen(false);
    onCloseRef.current?.();
  }, 160);

  const requestClose = useCallback((afterClose?: () => void) => {
    animRequestClose(() => { setOpen(false); onCloseRef.current?.(); afterClose?.(); });
  }, [animRequestClose]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    setPosition(computeAnchoredPosition(trigger.getBoundingClientRect(), getSizeRef.current()));
  }, [triggerRef]);

  const openMenu = useCallback(() => { updatePosition(); setOpen(true); }, [updatePosition]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const update = () => updatePosition();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) requestClose();
    };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    document.addEventListener("pointerdown", onPointerDown);

    let onKeyDown: ((event: KeyboardEvent) => void) | undefined;
    if (closeOnEscape) {
      onKeyDown = (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        requestClose(() => triggerRef.current?.focus());
      };
      document.addEventListener("keydown", onKeyDown);
    }
    let onFocusIn: ((event: FocusEvent) => void) | undefined;
    if (closeOnFocusOutside) {
      onFocusIn = (event) => {
        const target = event.target as Node;
        if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) requestClose();
      };
      document.addEventListener("focusin", onFocusIn);
    }
    const frame = window.requestAnimationFrame(() => focusOnOpenRef.current?.()?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      document.removeEventListener("pointerdown", onPointerDown);
      if (onKeyDown) document.removeEventListener("keydown", onKeyDown);
      if (onFocusIn) document.removeEventListener("focusin", onFocusIn);
    };
  }, [open, updatePosition, requestClose, triggerRef, menuRef, closeOnEscape, closeOnFocusOutside]);

  useEffect(() => {
    if (disabled && open) requestClose();
  }, [disabled, open, requestClose]);

  return { open, closing, position, opensUp: position.bottom !== "auto", openMenu, requestClose, onAnimationEnd };
}
