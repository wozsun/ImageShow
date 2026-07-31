import { useLayoutEffect } from "react";

const motionPausedAttribute = "data-document-motion-paused";

export function useDocumentMotionPause() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const setPaused = (paused: boolean) => {
      if (paused) {
        root.setAttribute(motionPausedAttribute, "true");
      } else {
        root.removeAttribute(motionPausedAttribute);
      }
    };
    const syncVisibility = () => {
      setPaused(document.visibilityState !== "visible");
    };
    const pauseForPageHide = () => setPaused(true);

    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    window.addEventListener("pagehide", pauseForPageHide);
    window.addEventListener("pageshow", syncVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      window.removeEventListener("pagehide", pauseForPageHide);
      window.removeEventListener("pageshow", syncVisibility);
      root.removeAttribute(motionPausedAttribute);
    };
  }, []);
}
