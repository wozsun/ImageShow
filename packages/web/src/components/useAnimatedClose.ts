import { useCallback, useEffect, useRef, useState, type AnimationEvent } from "react";

export function useAnimatedClose(onClose: () => void, fallbackMs = 170) {
  const [closing, setClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  const closeCallbackRef = useRef(onClose);
  const closingRef = useRef(false);
  const fallbackTimer = useRef<number | undefined>(undefined);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => () => window.clearTimeout(fallbackTimer.current), []);

  const finishClose = useCallback(() => {
    if (!closingRef.current) return;
    closingRef.current = false;
    window.clearTimeout(fallbackTimer.current);
    setClosing(false);
    closeCallbackRef.current();
  }, []);

  const requestClose = useCallback((afterClose?: () => void) => {
    if (closingRef.current) return;
    closeCallbackRef.current = afterClose ?? onCloseRef.current;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      closeCallbackRef.current();
      return;
    }
    closingRef.current = true;
    setClosing(true);
    fallbackTimer.current = window.setTimeout(finishClose, fallbackMs);
  }, [fallbackMs, finishClose]);

  const onAnimationEnd = useCallback((event: AnimationEvent<HTMLElement>) => {
    if (event.currentTarget === event.target) finishClose();
  }, [finishClose]);

  return { closing, requestClose, onAnimationEnd };
}
