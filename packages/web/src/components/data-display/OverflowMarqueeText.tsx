import { useLayoutEffect, useRef, useState } from "react";

type OverflowMarqueeTextProps = {
  text: string;
  as?: "span" | "strong";
  className?: string;
};

type VisibilityListener = (visible: boolean) => void;

const visibilityListeners = new Map<Element, VisibilityListener>();
let visibilityObserver: IntersectionObserver | undefined;

function observeVisibility(
  element: Element,
  listener: VisibilityListener
) {
  if (typeof IntersectionObserver === "undefined") {
    listener(true);
    return () => undefined;
  }

  visibilityObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      visibilityListeners.get(entry.target)?.(
        entry.isIntersecting && entry.intersectionRatio > 0
      );
    }
  });
  visibilityListeners.set(element, listener);
  visibilityObserver.observe(element);

  return () => {
    visibilityObserver?.unobserve(element);
    visibilityListeners.delete(element);
    if (visibilityListeners.size === 0) {
      visibilityObserver?.disconnect();
      visibilityObserver = undefined;
    }
  };
}

export function OverflowMarqueeText({
  text,
  as: Element = "span",
  className = ""
}: OverflowMarqueeTextProps) {
  const viewportRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [animating, setAnimating] = useState(false);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const content = contentRef.current;
    if (!viewport || !track || !content) return;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const interactionOwner = viewport.closest<HTMLElement>(
      "button, a, [tabindex]"
    ) ?? viewport;
    const pauseReasons = new Set<"focus" | "pointer">();
    let animation: Animation | undefined;
    let visible = typeof IntersectionObserver === "undefined";

    const cancelAnimation = (updateState = true) => {
      animation?.cancel();
      animation = undefined;
      if (updateState) setAnimating(false);
    };

    const measure = () => {
      cancelAnimation();

      const tailDistance = Math.max(
        0,
        Math.ceil(content.scrollWidth - viewport.clientWidth)
      );
      const nextHeadDistance = content.scrollWidth + 24;
      const isOverflowing = tailDistance > 1;
      setOverflowing(isOverflowing);
      if (!isOverflowing || motionQuery.matches || !visible) return;

      const headPauseMs = 1_500;
      const tailPauseMs = 1_000;
      const pixelsPerSecond = 32;
      const moveToTailMs = tailDistance / pixelsPerSecond * 1_000;
      const moveToNextHeadMs = (
        nextHeadDistance - tailDistance
      ) / pixelsPerSecond * 1_000;
      const duration = headPauseMs + moveToTailMs + tailPauseMs + moveToNextHeadMs;
      const tailArrivalOffset = (headPauseMs + moveToTailMs) / duration;
      const tailDepartureOffset = (
        headPauseMs + moveToTailMs + tailPauseMs
      ) / duration;

      const nextAnimation = track.animate([
        { transform: "translateX(0)", offset: 0 },
        { transform: "translateX(0)", offset: headPauseMs / duration },
        {
          transform: `translateX(-${tailDistance}px)`,
          offset: tailArrivalOffset
        },
        {
          transform: `translateX(-${tailDistance}px)`,
          offset: tailDepartureOffset
        },
        { transform: `translateX(-${nextHeadDistance}px)`, offset: 1 }
      ], {
        duration,
        easing: "linear",
        iterations: 1
      });
      animation = nextAnimation;
      nextAnimation.onfinish = () => {
        if (animation !== nextAnimation) return;
        nextAnimation.cancel();
        animation = undefined;
        setAnimating(false);
      };
      if (pauseReasons.size > 0) animation.pause();
      setAnimating(true);
    };

    const setPaused = (
      reason: "focus" | "pointer",
      paused: boolean
    ) => {
      if (paused) pauseReasons.add(reason);
      else pauseReasons.delete(reason);
      if (pauseReasons.size > 0) animation?.pause();
      else animation?.play();
    };
    const onPointerEnter = () => setPaused("pointer", true);
    const onPointerLeave = () => setPaused("pointer", false);
    const onFocus = () => setPaused("focus", true);
    const onBlur = () => setPaused("focus", false);

    measure();
    const stopObservingVisibility = observeVisibility(viewport, (nextVisible) => {
      if (visible === nextVisible) return;
      visible = nextVisible;
      measure();
    });
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(measure);
    observer?.observe(viewport);
    observer?.observe(content);
    motionQuery.addEventListener("change", measure);
    interactionOwner.addEventListener("pointerenter", onPointerEnter);
    interactionOwner.addEventListener("pointerleave", onPointerLeave);
    interactionOwner.addEventListener("focus", onFocus);
    interactionOwner.addEventListener("blur", onBlur);

    let active = true;
    void document.fonts?.ready.then(() => {
      if (active) measure();
    });
    return () => {
      active = false;
      cancelAnimation(false);
      observer?.disconnect();
      stopObservingVisibility();
      motionQuery.removeEventListener("change", measure);
      interactionOwner.removeEventListener("pointerenter", onPointerEnter);
      interactionOwner.removeEventListener("pointerleave", onPointerLeave);
      interactionOwner.removeEventListener("focus", onFocus);
      interactionOwner.removeEventListener("blur", onBlur);
    };
  }, [text]);

  return (
    <Element
      ref={viewportRef}
      className={[
        "overflow-marquee-text",
        overflowing ? "is-overflowing" : "",
        animating ? "is-animating" : "",
        className
      ].filter(Boolean).join(" ")}
      title={overflowing ? text : undefined}
    >
      <span ref={trackRef} className="overflow-marquee-track">
        <span ref={contentRef}>{text}</span>
        <span className="overflow-marquee-copy" aria-hidden="true">{text}</span>
      </span>
    </Element>
  );
}
