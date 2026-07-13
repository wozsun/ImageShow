import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { OverlayScrollbar } from "../layout/OverlayScrollbar.js";

const COLLAPSED_CARD_HEIGHT = 52;
const CARD_BOUNDARY_GAP = 8;
const EXPANDED_CARD_CHROME_HEIGHT = 42;

export function ImageDescriptionSlot({
  description,
  loading,
  error = "",
  onRetry,
  boundaryRef,
}: {
  description: string;
  loading: boolean;
  error?: string;
  onRetry?: () => void;
  boundaryRef: RefObject<HTMLElement | null>;
}) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const cardBodyRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [expandedHeight, setExpandedHeight] = useState(COLLAPSED_CARD_HEIGHT);
  const normalizedDescription = description.trim();
  const normalizedError = error.trim();
  const placeholder = normalizedError ? "详情加载失败" : loading ? "描述加载中…" : "暂无描述";
  const displayText = normalizedDescription || placeholder;

  const collapseDescription = useCallback(() => {
    setExpanded(false);
    setExpandedHeight(COLLAPSED_CARD_HEIGHT);
  }, []);

  const measureExpandedHeight = useCallback(() => {
    const slotElement = slotRef.current;
    const textElement = textRef.current;
    const contentElement = slotElement?.closest(".image-detail-content");
    if (!slotElement || !textElement || !(contentElement instanceof HTMLElement)) return;

    const slotBounds = slotElement.getBoundingClientRect();
    const contentBounds = contentElement.getBoundingClientRect();
    const boundaryBounds = boundaryRef.current?.getBoundingClientRect();
    let availableBottom = Math.min(contentBounds.bottom, window.innerHeight);

    if (boundaryBounds && boundaryBounds.top > slotBounds.bottom) {
      availableBottom = Math.min(availableBottom, boundaryBounds.top - CARD_BOUNDARY_GAP);
    }

    const availableHeight = Math.max(
      COLLAPSED_CARD_HEIGHT,
      Math.floor(availableBottom - slotBounds.top),
    );
    const contentHeight = Math.max(
      COLLAPSED_CARD_HEIGHT,
      Math.ceil(textElement.scrollHeight + EXPANDED_CARD_CHROME_HEIGHT),
    );
    setExpandedHeight(Math.min(availableHeight, contentHeight));
  }, [boundaryRef]);

  useEffect(() => {
    collapseDescription();
  }, [collapseDescription, description, loading, normalizedError]);

  useEffect(() => {
    if (!expanded) return;

    const collapseFromOutsideTouch = (event: TouchEvent) => {
      if (cardRef.current?.contains(event.target as Node)) return;
      collapseDescription();
    };

    document.addEventListener("touchstart", collapseFromOutsideTouch, {
      capture: true,
      passive: true,
    });
    return () => {
      document.removeEventListener("touchstart", collapseFromOutsideTouch, true);
    };
  }, [collapseDescription, expanded]);

  useLayoutEffect(() => {
    const textElement = textRef.current;
    if (expanded) return;
    if (!textElement || loading || normalizedError || !normalizedDescription) {
      setOverflowing(false);
      return;
    }

    const measureOverflow = () => {
      setOverflowing(textElement.scrollHeight > textElement.clientHeight + 1);
    };
    measureOverflow();
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(textElement);
    return () => observer.disconnect();
  }, [expanded, loading, normalizedDescription, normalizedError]);

  useLayoutEffect(() => {
    if (!expanded) return;

    const contentElement = slotRef.current?.closest(".image-detail-content");
    if (!(contentElement instanceof HTMLElement)) return;

    measureExpandedHeight();
    const observer = new ResizeObserver(measureExpandedHeight);
    observer.observe(contentElement);
    if (textRef.current) observer.observe(textRef.current);
    if (boundaryRef.current) observer.observe(boundaryRef.current);
    window.addEventListener("resize", measureExpandedHeight);
    contentElement.addEventListener("scroll", measureExpandedHeight, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measureExpandedHeight);
      contentElement.removeEventListener("scroll", measureExpandedHeight);
    };
  }, [boundaryRef, expanded, measureExpandedHeight]);

  return (
    <div ref={slotRef} className="image-detail-description-slot" aria-busy={loading}>
      <section
        ref={cardRef}
        className={`image-detail-description-card${expanded ? " is-expanded" : ""}`}
        aria-label="图片描述"
        style={{ height: `${expanded ? expandedHeight : COLLAPSED_CARD_HEIGHT}px` }}
      >
        <div ref={cardBodyRef} className="image-detail-description-card-body">
          <p
            ref={textRef}
            className={`image-detail-description-text${normalizedDescription ? "" : " is-placeholder"}${normalizedError ? " is-error" : ""}`}
            aria-live="polite"
            role={normalizedError ? "alert" : undefined}
            title={normalizedError || undefined}
          >
            {displayText}
          </p>
        </div>
        {normalizedError && onRetry && (
          <button
            type="button"
            className="image-detail-description-retry"
            title="重新加载图片详情"
            onClick={onRetry}
          >
            重试
          </button>
        )}
        {overflowing && (
          <button
            type="button"
            className="image-detail-description-toggle"
            aria-expanded={expanded}
            onClick={() => {
              if (expanded) {
                collapseDescription();
                return;
              }
              setExpanded(true);
            }}
          >
            {expanded ? "收起" : "展开"}
          </button>
        )}
        {expanded && (
          <OverlayScrollbar
            targetRef={cardBodyRef}
            containerRef={cardRef}
            enableOnTouch
          />
        )}
      </section>
    </div>
  );
}
