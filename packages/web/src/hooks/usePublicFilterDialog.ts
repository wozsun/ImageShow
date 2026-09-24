import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { useImageBrowseRoute } from "./useImageBrowseRoute.js";
import { isPageScrollLocked, pageScrollRestoredEvent } from "./usePageScrollLock.js";
import type { GalleryFilters } from "../lib/gallery/gallery-query.js";

type Session = {
  identity: string;
  filters: GalleryFilters;
  unresolvedTags: string[];
  unresolvedSelectors: ReturnType<typeof useImageBrowseRoute>["unresolvedSelectors"];
};

/** The page holds the close-to-navigation handoff after the dialog has unmounted. */
export function usePublicFilterDialog(
  route: Pick<
    ReturnType<typeof useImageBrowseRoute>,
    "filters" | "ready" | "params" | "unresolvedSelectors" | "applyFilters"
  >
) {
  const location = useLocation();
  const identity = JSON.stringify([location.pathname, location.key, location.search]);
  const [session, setSession] = useState<Session | null>(null);
  const [handoff, setHandoff] = useState(false);
  const pendingRef = useRef<{ identity: string; filters: GalleryFilters } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const currentIdentityRef = useRef(identity);
  currentIdentityRef.current = identity;
  const activeSession = session?.identity === identity ? session : null;

  useLayoutEffect(() => {
    pendingRef.current = null;
    setSession(null);
    setHandoff(false);
  }, [identity]);

  const finishHandoff = useEffectEvent(() => {
    if (isPageScrollLocked()) return;
    const pending = pendingRef.current;
    pendingRef.current = null;
    setHandoff(false);
    if (pending?.identity === currentIdentityRef.current) route.applyFilters(pending.filters);
  });
  useEffect(() => {
    if (!handoff) return;
    const finish = () => finishHandoff();
    window.addEventListener(pageScrollRestoredEvent, finish);
    finish();
    return () => window.removeEventListener(pageScrollRestoredEvent, finish);
  }, [handoff]);

  return {
    session: activeSession,
    active: Boolean(activeSession) || handoff,
    triggerRef,
    open: () => {
      pendingRef.current = null;
      setHandoff(false);
      setSession({
        identity,
        filters: { ...route.filters },
        unresolvedSelectors: route.unresolvedSelectors,
        unresolvedTags: route.ready ? [] : route.params.getAll("tag")
      });
    },
    close: () => setSession(null),
    applyAfterClose: (filters: GalleryFilters) => {
      if (!activeSession || activeSession.identity !== currentIdentityRef.current) return;
      pendingRef.current = { identity: activeSession.identity, filters };
      setHandoff(true);
      setSession(null);
    }
  };
}
