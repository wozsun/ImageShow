import {
  useCallback,
  useState
} from "react";

let publicNavigationHasAppeared = false;

function reducedMotionPreferred() {
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function usePublicNavigationEntrance() {
  const [entrance] = useState(() => {
    const hadAppearedBeforeMount = publicNavigationHasAppeared;
    const motionAllowed = !reducedMotionPreferred();
    return {
      hadAppearedBeforeMount,
      motionAllowed,
      shouldAnimate: !hadAppearedBeforeMount && motionAllowed
    };
  });
  const markAppeared = useCallback(() => {
    publicNavigationHasAppeared = true;
  }, []);

  return { ...entrance, markAppeared };
}
