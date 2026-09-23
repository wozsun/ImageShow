import { useLayoutEffect, useRef, useState } from "react";

/** A parent keeps refresh runs even when an entrance has not mounted its indicators yet. */
export function useRefreshGlintRun(refreshing: boolean) {
  const wasRefreshing = useRef(refreshing);
  const [run, setRun] = useState(refreshing ? 1 : 0);
  useLayoutEffect(() => {
    if (refreshing && !wasRefreshing.current) setRun((current) => current + 1);
    wasRefreshing.current = refreshing;
  }, [refreshing]);
  return run;
}

/** End on a CSS cycle boundary, never on the network completion boundary. */
export function useRefreshGlint(run: number, refreshing: boolean, reduceMotion: boolean) {
  const [completedRun, setCompletedRun] = useState(reduceMotion && !refreshing ? run : 0);
  useLayoutEffect(() => {
    if (reduceMotion && !refreshing) setCompletedRun(run);
  }, [run, refreshing, reduceMotion]);
  return {
    active: run > completedRun && (!reduceMotion || refreshing),
    finishCycle: () => { if (!refreshing) setCompletedRun(run); }
  };
}
