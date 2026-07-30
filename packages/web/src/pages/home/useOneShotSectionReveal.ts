import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState
} from "react";

const sectionRevealRootMargin = "140px 0px";

function reducedMotionPreferred() {
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function useOneShotSectionReveal(armed: boolean) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [revealed, setRevealed] = useState(reducedMotionPreferred);
  const [revealedImmediately, setRevealedImmediately] = useState(
    reducedMotionPreferred
  );
  const reveal = useCallback(() => setRevealed(true), []);
  const revealImmediately = useCallback(() => {
    setRevealedImmediately(true);
    reveal();
  }, [reveal]);

  useLayoutEffect(() => {
    if (!armed || revealed) return;
    const section = sectionRef.current;
    if (!section) return;

    const motionQuery = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    );
    if (
      motionQuery.matches
      || typeof IntersectionObserver === "undefined"
    ) {
      revealImmediately();
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) reveal();
    }, { rootMargin: sectionRevealRootMargin });
    const revealForReducedMotion = () => {
      if (motionQuery.matches) revealImmediately();
    };
    observer.observe(section);
    motionQuery.addEventListener("change", revealForReducedMotion);
    return () => {
      observer.disconnect();
      motionQuery.removeEventListener("change", revealForReducedMotion);
    };
  }, [armed, reveal, revealImmediately, revealed]);

  return {
    revealImmediately,
    revealed,
    revealedImmediately,
    sectionRef
  };
}
