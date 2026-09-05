import { useEffect, useEffectEvent } from "react";
import { publicNavigationTopEdgeRevealHeight } from "../lib/ui/public-navigation.js";

export function usePublicNavigationTopEdgeReveal(
  onReveal: () => void,
  enabled = true
) {
  const reveal = useEffectEvent(onReveal);

  useEffect(() => {
    if (!enabled) return;
    let insideTopEdge = false;
    const updatePointerPosition = (event: PointerEvent) => {
      // Pixi dispatches document pointer moves with cached coordinates while
      // animating cards. Only a real mouse can reveal the navigation.
      if (!event.isTrusted || event.pointerType !== "mouse") return;
      const nextInsideTopEdge = event.clientY >= 0
        && event.clientY < publicNavigationTopEdgeRevealHeight;
      // 每次移入只唤出一次；区内移动不延长无点击隐藏计时，拖动也不触发唤出。
      if (nextInsideTopEdge && !insideTopEdge && event.buttons === 0) reveal();
      insideTopEdge = nextInsideTopEdge;
    };
    const enterDocument = (event: PointerEvent) => {
      // Layout/animation can retarget hover without moving the mouse.
      // Internal pointerover events must not reopen a collapsing navigation.
      if (event.relatedTarget === null) updatePointerPosition(event);
    };
    const leaveDocument = (event: PointerEvent) => {
      if (event.isTrusted && event.pointerType === "mouse" && event.relatedTarget === null) {
        insideTopEdge = false;
      }
    };

    document.addEventListener("pointermove", updatePointerPosition, { capture: true, passive: true });
    document.addEventListener("pointerover", enterDocument, { capture: true, passive: true });
    document.addEventListener("pointerout", leaveDocument, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointermove", updatePointerPosition, true);
      document.removeEventListener("pointerover", enterDocument, true);
      document.removeEventListener("pointerout", leaveDocument, true);
    };
  }, [enabled]);
}
