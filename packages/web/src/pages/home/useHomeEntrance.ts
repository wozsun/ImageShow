import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type SyntheticEvent
} from "react";
import {
  HomeEntranceController,
  type HomeEntranceSnapshot
} from "./home-entrance-controller.js";

type ActiveHomeEntrance = {
  controller: HomeEntranceController;
  decodeStarted: boolean;
  generation: number;
};

type HomeBackgroundDecode = {
  image: HTMLImageElement;
  readiness: Promise<boolean>;
};

function reducedMotionPreferred() {
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function useHomeEntrance(source: string) {
  const [snapshot, setSnapshot] = useState<HomeEntranceSnapshot>(() => {
    const revealImmediately = reducedMotionPreferred();
    return {
      navigationRevealed: revealImmediately,
      heroRevealed: revealImmediately,
      backgroundReady: false,
      backgroundReadyAfterForeground: false
    };
  });
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const imageRef = useRef<HTMLImageElement | null>(null);
  const activeRef = useRef<ActiveHomeEntrance | null>(null);
  const decodeRef = useRef<HomeBackgroundDecode | null>(null);
  const generationRef = useRef(0);

  const settleLoadedImage = useCallback((image: HTMLImageElement) => {
    const active = activeRef.current;
    if (
      !active
      || active.decodeStarted
      || imageRef.current !== image
    ) return;
    active.decodeStarted = true;

    let decode = decodeRef.current;
    if (decode?.image !== image) {
      const readiness = typeof image.decode !== "function"
        ? Promise.resolve(true)
        : image.decode().then(
            () => true,
            () => image.complete && image.naturalWidth > 0
          );
      decode = { image, readiness };
      decodeRef.current = decode;
    }
    void decode.readiness.then((ready) => {
      if (ready && activeRef.current === active) {
        active.controller.backgroundBecameReady();
      }
    });
  }, []);

  const onBackgroundLoad = useCallback((
    event: SyntheticEvent<HTMLImageElement>
  ) => {
    settleLoadedImage(event.currentTarget);
  }, [settleLoadedImage]);

  const onBackgroundError = useCallback((
    event: SyntheticEvent<HTMLImageElement>
  ) => {
    const active = activeRef.current;
    if (!active || imageRef.current !== event.currentTarget) return;
    active.controller.backgroundFailed();
  }, []);

  useLayoutEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const reduceMotion = reducedMotionPreferred();
    const foregroundAlreadyVisible = reduceMotion
      || snapshotRef.current.navigationRevealed
      || snapshotRef.current.heroRevealed;
    const controller = new HomeEntranceController({
      initiallyRevealed: foregroundAlreadyVisible,
      onChange: (nextSnapshot) => {
        if (activeRef.current?.generation === generation) {
          snapshotRef.current = nextSnapshot;
          setSnapshot(nextSnapshot);
        }
      }
    });
    const active: ActiveHomeEntrance = {
      controller,
      decodeStarted: false,
      generation
    };
    activeRef.current = active;

    setSnapshot((current) => {
      const preserveForeground = reduceMotion
        || current.navigationRevealed
        || current.heroRevealed;
      const nextSnapshot = {
        navigationRevealed: preserveForeground,
        heroRevealed: preserveForeground,
        backgroundReady: false,
        backgroundReadyAfterForeground: false
      };
      snapshotRef.current = nextSnapshot;
      return nextSnapshot;
    });
    controller.start();

    const motionQuery = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    );
    const revealForReducedMotion = () => {
      if (motionQuery.matches) controller.revealImmediately();
    };
    const checkVisibleDeadlines = () => {
      if (document.visibilityState === "visible") {
        controller.checkDeadlines();
      }
    };
    motionQuery.addEventListener("change", revealForReducedMotion);
    document.addEventListener("visibilitychange", checkVisibleDeadlines);

    const image = imageRef.current;
    if (image && image.getAttribute("src") !== source) {
      // This effect is the sole src owner so Strict Mode replay and visual
      // state commits cannot start the same background request again.
      image.setAttribute("src", source);
    }
    if (image) {
      controller.backgroundRequestStarted();
    }
    if (image?.complete && image.naturalWidth > 0) {
      settleLoadedImage(image);
    }

    return () => {
      motionQuery.removeEventListener("change", revealForReducedMotion);
      document.removeEventListener("visibilitychange", checkVisibleDeadlines);
      controller.dispose();
      if (activeRef.current === active) activeRef.current = null;
    };
  }, [settleLoadedImage, source]);

  return {
    backgroundReady: snapshot.backgroundReady,
    backgroundReadyAfterForeground: snapshot.backgroundReadyAfterForeground,
    heroRevealed: snapshot.heroRevealed,
    navigationRevealed: snapshot.navigationRevealed,
    imageRef,
    onBackgroundError,
    onBackgroundLoad
  };
}
