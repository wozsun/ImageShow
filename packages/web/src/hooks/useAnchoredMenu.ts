import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useAnimatedClose } from "./useAnimatedClose.js";
import {
  computeAnchoredPosition,
  type AnchoredMenuPosition,
  type AnchoredMenuSize
} from "../lib/ui/menu-position.js";

function naturalMenuHeight(menu: HTMLElement | null) {
  if (!menu) return undefined;
  // scrollHeight 保留被 max-height 裁掉的内容高度；补回上下边框后得到最终
  // border-box 高度。offset/clientHeight 都不受菜单入场 transform 动画影响。
  return menu.scrollHeight + Math.max(0, menu.offsetHeight - menu.clientHeight);
}

export function useAnchoredMenu(options: {
  triggerRef: RefObject<HTMLElement | null>;
  getSize: () => AnchoredMenuSize;
  initialMaxHeight: number;
  disabled?: boolean;
  onClose?: () => void;
  closeOnEscape?: boolean;
  closeOnFocusOutside?: boolean;
  focusOnOpen?: () => HTMLElement | null | undefined;
}) {
  const { triggerRef, disabled = false, closeOnEscape = false, closeOnFocusOutside = false } = options;
  const [open, setOpen] = useState(false);
  const menuNodeRef = useRef<HTMLElement | null>(null);
  const [menuNode, setMenuNode] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<AnchoredMenuPosition>({
    placement: "below",
    style: { left: 0, top: 0, bottom: "auto", width: 0, maxHeight: options.initialMaxHeight }
  });

  const getSizeRef = useRef(options.getSize); getSizeRef.current = options.getSize;
  const onCloseRef = useRef(options.onClose); onCloseRef.current = options.onClose;
  const focusOnOpenRef = useRef(options.focusOnOpen); focusOnOpenRef.current = options.focusOnOpen;

  // RefObject.current 的变化不会触发 effect。用稳定的 callback ref 同时保存
  // 当前节点并触发一次渲染，让条件渲染的菜单首次挂载时也能进入测量与观察流程。
  const menuRef = useCallback((node: HTMLElement | null) => {
    menuNodeRef.current = node;
    setMenuNode((current) => current === node ? current : node);
  }, []);

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
    setPosition(computeAnchoredPosition(
      trigger.getBoundingClientRect(),
      getSizeRef.current(),
      naturalMenuHeight(menuNodeRef.current)
    ));
  }, [triggerRef]);

  const openMenu = useCallback(() => { updatePosition(); setOpen(true); }, [updatePosition]);

  // Portal 挂载并取得真实菜单高度后，在浏览器绘制前校正向上展开的位置，
  // 避免先按最大高度定位再在下一帧跳动。
  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, menuNode, updatePosition]);

  useEffect(() => {
    if (!open) return;
    let positionFrame: number | undefined;
    const update = () => {
      if (positionFrame !== undefined) return;
      positionFrame = window.requestAnimationFrame(() => {
        positionFrame = undefined;
        updatePosition();
      });
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuNodeRef.current?.contains(target)) requestClose();
    };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    document.addEventListener("pointerdown", onPointerDown);

    // 折叠区、标签 chip 或字体加载改变锚点/菜单尺寸时也重新测量；只在共享层处理，
    // ThemeInput、AuthorInput、TagInput 无需分别补丁。
    const resizeObserver = new ResizeObserver(update);
    if (triggerRef.current) resizeObserver.observe(triggerRef.current);
    if (menuNode) resizeObserver.observe(menuNode);

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
        if (!triggerRef.current?.contains(target) && !menuNodeRef.current?.contains(target)) requestClose();
      };
      document.addEventListener("focusin", onFocusIn);
    }
    return () => {
      if (positionFrame !== undefined) window.cancelAnimationFrame(positionFrame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      document.removeEventListener("pointerdown", onPointerDown);
      resizeObserver.disconnect();
      if (onKeyDown) document.removeEventListener("keydown", onKeyDown);
      if (onFocusIn) document.removeEventListener("focusin", onFocusIn);
    };
  }, [open, menuNode, updatePosition, requestClose, triggerRef, closeOnEscape, closeOnFocusOutside]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => focusOnOpenRef.current?.()?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (disabled && open) requestClose();
  }, [disabled, open, requestClose]);

  return {
    open,
    closing,
    position: position.style,
    opensUp: position.placement === "above",
    menuRef,
    openMenu,
    requestClose,
    onAnimationEnd
  };
}
