import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

function reducedMotionPreferred() {
  return typeof window !== "undefined"
    && window.matchMedia?.(reducedMotionQuery).matches === true;
}

/**
 * Keeps a CSS entrance class active for only one animation lifecycle.
 * Once finished or interrupted by reduced motion, the class cannot return.
 */
export function useOneShotAnimation(enabled: boolean) {
  const startedRef = useRef(enabled);
  const [active, setActive] = useState(
    () => enabled && !reducedMotionPreferred()
  );

  useLayoutEffect(() => {
    if (!enabled) {
      setActive(false);
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    if (!reducedMotionPreferred()) setActive(true);
  }, [enabled]);

  useEffect(() => {
    if (!active) return;
    const motionQuery = window.matchMedia(reducedMotionQuery);
    const stopForReducedMotion = () => {
      if (motionQuery.matches) setActive(false);
    };
    stopForReducedMotion();
    motionQuery.addEventListener("change", stopForReducedMotion);
    return () => {
      motionQuery.removeEventListener("change", stopForReducedMotion);
    };
  }, [active]);

  const finish = useCallback(() => setActive(false), []);

  return { active, finish };
}
