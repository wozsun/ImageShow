import {
  useCallback,
  useState
} from "react";
import { reducedMotionPreferred } from "../lib/ui/reduced-motion.js";

let publicNavigationHasAppeared = false;

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
