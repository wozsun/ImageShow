import { useEffect, useState } from "react";

function documentMotionPaused() {
  return typeof document !== "undefined"
    && document.visibilityState !== "visible";
}

export function useDocumentMotionPaused() {
  const [paused, setPaused] = useState(documentMotionPaused);

  useEffect(() => {
    const update = () => setPaused(documentMotionPaused());
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return paused;
}
