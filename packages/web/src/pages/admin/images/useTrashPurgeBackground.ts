import { useCallback, useEffect, useRef, useState } from "react";
import type { TrashPurgeProgressDto } from "@imageshow/shared/browser";
import {
  openTrashPurgeProgress,
  type TrashPurgeProgressStream
} from "./trash-purge-progress.js";

type BackgroundFollow = {
  stream: TrashPurgeProgressStream;
  followedPendingWork: boolean;
};

/**
 * Owns the purge progress shown in the page subtitle. It checks once on mount,
 * where an idle trash costs one short request, and follows again when the
 * confirmation dialog hands its deletion over to the background.
 */
export function useTrashPurgeBackground({
  enabled,
  onSettled
}: {
  enabled: boolean;
  /** The final state, or null when the stream stopped before it. */
  onSettled: (final: TrashPurgeProgressDto | null) => void;
}) {
  const [progress, setProgress] = useState<TrashPurgeProgressDto | null>(null);
  const followRef = useRef<BackgroundFollow | null>(null);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const follow = useCallback((handedOver = false) => {
    const active = followRef.current;
    if (active) {
      // The stream already following settles the handed-over deletion too.
      active.followedPendingWork ||= handedOver;
      return;
    }
    // A handed-over deletion settles even when it finishes before the first
    // state, so the list still refreshes and the result is reported.
    const following: BackgroundFollow = {
      followedPendingWork: handedOver,
      stream: openTrashPurgeProgress((next) => {
        if (!next.pending) return;
        following.followedPendingWork = true;
        setProgress(next);
      })
    };
    followRef.current = following;
    void following.stream.done.then((final) => {
      // Unmount detaches the stream before closing it.
      if (followRef.current !== following) return;
      followRef.current = null;
      setProgress(null);
      if (following.followedPendingWork) onSettledRef.current(final);
    });
  }, []);

  /**
   * The caller already settled the current global completion, so this stream
   * settles again only for work that starts after it.
   */
  const acknowledgeCompletion = useCallback(() => {
    if (followRef.current) followRef.current.followedPendingWork = false;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    follow();
    return () => {
      const following = followRef.current;
      followRef.current = null;
      following?.stream.close();
    };
  }, [enabled, follow]);

  return { progress, follow, acknowledgeCompletion };
}
