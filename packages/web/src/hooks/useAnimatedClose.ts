import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent
} from "react";

export function useAnimatedClose(onClose: () => void, fallbackMs = 170) {
  const [closing, setClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  const closeCallbackRef = useRef(onClose);
  const closingRef = useRef(false);
  const mountedRef = useRef(false);
  const fallbackTimer = useRef<number | undefined>(undefined);

  // requestClose 会冻结当次回调；先在布局阶段发布最新已提交版本，避免刚绘制的
  // 状态已经可交互，而被动 effect 仍让关闭请求读到上一次提交。
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      closingRef.current = false;
      window.clearTimeout(fallbackTimer.current);
    };
  }, []);

  const finishClose = useCallback(() => {
    if (!mountedRef.current || !closingRef.current) return;
    closingRef.current = false;
    window.clearTimeout(fallbackTimer.current);
    setClosing(false);
    closeCallbackRef.current();
  }, []);

  // prepareClose 只在首次关闭请求被接受时运行，并返回退场结束后的收尾动作。
  const requestClose = useCallback((
    afterClose?: () => void,
    prepareClose?: () => () => void
  ) => {
    if (!mountedRef.current || closingRef.current) return;
    closeCallbackRef.current = afterClose
      ?? prepareClose?.()
      ?? onCloseRef.current;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      closeCallbackRef.current();
      return;
    }
    closingRef.current = true;
    setClosing(true);
    fallbackTimer.current = window.setTimeout(finishClose, fallbackMs);
  }, [fallbackMs, finishClose]);

  const cancelClose = useCallback(() => {
    if (!mountedRef.current || !closingRef.current) return;
    closingRef.current = false;
    window.clearTimeout(fallbackTimer.current);
    setClosing(false);
  }, []);

  const onAnimationEnd = useCallback((event: AnimationEvent<HTMLElement>) => {
    if (event.currentTarget === event.target) finishClose();
  }, [finishClose]);

  return { closing, requestClose, cancelClose, onAnimationEnd };
}
