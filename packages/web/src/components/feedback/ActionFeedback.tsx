import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent,
  type CSSProperties
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icon/Icon.js";

type ActionFeedbackStatus = "info" | "pending" | "success" | "error";

export type ActionFeedbackState = {
  id: number;
  text: string;
  status: ActionFeedbackStatus;
};

const actionFeedbackDefaultDurationMs = 6_000;
let actionFeedbackSequence = 0;

export function createActionFeedback(
  text: string,
  status: ActionFeedbackStatus
): ActionFeedbackState {
  actionFeedbackSequence += 1;
  return { id: actionFeedbackSequence, text, status };
}

type ActionFeedbackStyle = CSSProperties & {
  "--action-feedback-duration"?: string;
};

type ActionFeedbackPlacement = "inline" | "floating";

const floatingViewportInsetPx = 16;
const floatingCollisionGapPx = 10;
type FloatingFeedbackPosition = {
  top: number;
  right: number | null;
};
type FloatingFeedbackRect = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

const pageAvoidanceSelector = [
  ".admin-mobile-header button",
  ".admin-mobile-header a.button",
  ".workspace-head button",
  ".workspace-head .button",
  ".toolbar button",
  ".toolbar .button",
  "[data-feedback-avoid]"
].join(",");
const scrollRegionSelector = [
  ".admin-scroll-region",
  ".admin-scroll-list",
  ".settings-scroll-region",
  ".modal-scroll-list",
  ".operation-body",
  ".log-viewer",
  ".advanced-config-page",
  ".advanced-config-code-editor .cm-scroller",
  ".image-detail-content",
  ".link-import-card",
  ".admin-mobile-navigation .mobile-nav-dropdown",
  ".select-menu",
  ".facet-select-menu",
  ".jsonl-error-list"
].join(",");
const feedbackRowSelector = [
  ".workspace-head",
  ".toolbar",
  ".admin-create-form",
  ".log-toolbar",
  ".advanced-config-editor-head",
  ".modal header",
  ".upload-window > header",
  ".link-import-head",
  ".image-detail-head"
].join(",");
const dialogAvoidanceSelector = [
  "header button",
  "header .button",
  "footer button",
  "footer .button",
  "[data-feedback-avoid]"
].join(",");
const rowControlSelector = [
  "button",
  ".button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "[role='button']",
  "[role='switch']",
  "[data-feedback-avoid]"
].join(",");

function visibleRect(
  element: HTMLElement,
  style = window.getComputedStyle(element)
) {
  if (style.display === "none" || style.visibility === "hidden") return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) return null;
  return rect;
}

function visibleLayoutRects(element: HTMLElement): DOMRect[] {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return [];
  if (style.display === "contents") {
    return [...element.children].flatMap((child) => (
      child instanceof HTMLElement ? visibleLayoutRects(child) : []
    ));
  }
  const rect = visibleRect(element, style);
  return rect ? [rect] : [];
}

function visibleScrollRegionRect(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  if (style.overflowY !== "auto" && style.overflowY !== "scroll") return null;
  return visibleRect(element, style);
}

function overlapArea(
  feedback: FloatingFeedbackRect,
  target: DOMRect
) {
  const width = Math.max(0, Math.min(feedback.right, target.right) - Math.max(feedback.left, target.left));
  const height = Math.max(0, Math.min(feedback.bottom, target.bottom) - Math.max(feedback.top, target.top));
  return width * height;
}

function overlapsAny(candidate: FloatingFeedbackRect, targets: DOMRect[]) {
  return targets.some((target) => overlapArea(candidate, target) > 0);
}

function candidateRect(
  feedbackRect: DOMRect,
  top: number,
  left: number
): FloatingFeedbackRect {
  return {
    top,
    right: left + feedbackRect.width,
    bottom: top + feedbackRect.height,
    left
  };
}

function withinViewport(candidate: FloatingFeedbackRect) {
  return candidate.top >= floatingViewportInsetPx
    && candidate.left >= floatingViewportInsetPx
    && candidate.right <= window.innerWidth - floatingViewportInsetPx
    && candidate.bottom <= window.innerHeight - floatingViewportInsetPx;
}

function toFloatingPosition(candidate: FloatingFeedbackRect): FloatingFeedbackPosition {
  return {
    top: candidate.top,
    right: window.innerWidth - candidate.right
  };
}

function samePosition(
  current: FloatingFeedbackPosition | null,
  next: FloatingFeedbackPosition | null
) {
  if (current === null || next === null) return current === next;
  const sameRight = current.right === null || next.right === null
    ? current.right === next.right
    : Math.abs(current.right - next.right) < 0.5;
  return Math.abs(current.top - next.top) < 0.5
    && sameRight;
}

function horizontalCandidates(
  feedbackRect: DOMRect,
  top: number,
  rowLeft: number,
  rowRight: number,
  blockers: DOMRect[]
) {
  const bottom = top + feedbackRect.height;
  const relevantBlockers = blockers
    .filter((rect) => (
      rect.bottom > top
      && rect.top < bottom
      && rect.right > rowLeft
      && rect.left < rowRight
    ))
    .sort((left, right) => left.left - right.left);
  const gaps: Array<{ left: number; right: number }> = [];
  let gapLeft = rowLeft;

  for (const rect of relevantBlockers) {
    const occupiedLeft = Math.max(rowLeft, rect.left - floatingCollisionGapPx);
    const occupiedRight = Math.min(rowRight, rect.right + floatingCollisionGapPx);
    if (occupiedLeft > gapLeft) gaps.push({ left: gapLeft, right: occupiedLeft });
    gapLeft = Math.max(gapLeft, occupiedRight);
  }
  if (gapLeft < rowRight) gaps.push({ left: gapLeft, right: rowRight });

  // 同一行从右向左尝试每段空白，避免最靠右候选碰到独立控件后直接放弃整行。
  return gaps
    .filter((gap) => gap.right - gap.left >= feedbackRect.width)
    .reverse()
    .map((gap) => candidateRect(feedbackRect, top, gap.right - feedbackRect.width));
}

function rowCandidates(
  row: HTMLElement,
  feedbackRect: DOMRect,
  avoidanceRects: DOMRect[]
) {
  const rowRect = visibleRect(row);
  if (!rowRect) return null;

  const availableTop = Math.max(floatingViewportInsetPx, rowRect.top);
  const availableBottom = Math.min(
    window.innerHeight - floatingViewportInsetPx,
    rowRect.bottom
  );
  const availableHeight = availableBottom - availableTop;
  if (availableHeight < feedbackRect.height) return null;

  // 候选必须完整落在当前固定行中。不能只以行中心为基准后钳制到视口，
  // 否则较高的多行提示会伸入相邻固定行，遮挡那一行的字段或说明。
  const top = availableTop + (availableHeight - feedbackRect.height) / 2;
  const rowLeft = Math.max(floatingViewportInsetPx, rowRect.left);
  const rowRight = Math.min(window.innerWidth - floatingViewportInsetPx, rowRect.right);
  const occupied = [...row.children]
    .filter((child): child is HTMLElement => child instanceof HTMLElement)
    .flatMap(visibleLayoutRects);
  const controls = [...row.querySelectorAll<HTMLElement>(rowControlSelector)]
    .flatMap(visibleLayoutRects);
  const protectedRects = [...avoidanceRects, ...controls];

  return {
    occupied,
    controls,
    strict: horizontalCandidates(
      feedbackRect,
      top,
      rowLeft,
      rowRight,
      [...occupied, ...protectedRects]
    ),
    // 对话框没有纯空白时，最后允许覆盖非交互文字，但仍完整留在该行，
    // 且绝不覆盖输入框、选择器、关闭或提交等操作控件。
    controlSafe: horizontalCandidates(
      feedbackRect,
      top,
      rowLeft,
      rowRight,
      protectedRects
    )
  };
}

function activeDialog() {
  const dialogs = [...document.querySelectorAll<HTMLElement>(".modal, .upload-overlay")]
    .map((element) => ({ element, rect: visibleRect(element) }))
    .filter((entry): entry is { element: HTMLElement; rect: DOMRect } => entry.rect !== null);
  if (!dialogs.length) return null;

  return dialogs.reduce((current, candidate) => {
    const currentLayer = Number.parseInt(window.getComputedStyle(current.element).zIndex, 10) || 0;
    const candidateLayer = Number.parseInt(window.getComputedStyle(candidate.element).zIndex, 10) || 0;
    return candidateLayer >= currentLayer ? candidate : current;
  }).element;
}

function useFloatingFeedbackPosition(enabled: boolean, feedbackKey: string) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [position, setPosition] = useState<FloatingFeedbackPosition | null>(null);

  const measure = useCallback(() => {
    const element = elementRef.current;
    if (!enabled || !element) return;
    const feedbackRect = element.getBoundingClientRect();
    if (feedbackRect.width <= 0 || feedbackRect.height <= 0) return;

    const dialog = activeDialog();
    const avoidanceRoot: ParentNode = dialog ?? document;
    const selector = dialog ? dialogAvoidanceSelector : pageAvoidanceSelector;
    const mobileNavigation = document.querySelector<HTMLElement>(".admin-mobile-header");
    // 全屏或模态对话框打开后，后台导航实际被遮罩覆盖，不应再参与当前层的
    // 碰撞与兜底计算；否则提示会被错误地推到这个不可见导航的下方。
    const mobileNavigationRect = !dialog && mobileNavigation
      ? visibleRect(mobileNavigation)
      : null;
    const targetRects = [...avoidanceRoot.querySelectorAll<HTMLElement>(selector)]
      .filter((target) => !element.contains(target))
      .map((target) => visibleRect(target))
      .filter((rect): rect is DOMRect => rect !== null);
    if (mobileNavigationRect) targetRects.push(mobileNavigationRect);
    const scrollRegionRects = [...avoidanceRoot.querySelectorAll<HTMLElement>(scrollRegionSelector)]
      .filter((target) => !element.contains(target))
      .map(visibleScrollRegionRect)
      .filter((rect): rect is DOMRect => rect !== null);

    const isAllowed = (candidate: FloatingFeedbackRect, protectedRects: DOMRect[] = []) => (
      withinViewport(candidate)
      && !overlapsAny(candidate, targetRects)
      && !overlapsAny(candidate, protectedRects)
      && !overlapsAny(candidate, scrollRegionRects)
    );
    const updatePosition = (next: FloatingFeedbackPosition | null) => {
      setPosition((current) => samePosition(current, next) ? current : next);
    };

    const scrollBoundaryTop = scrollRegionRects.length
      ? Math.min(...scrollRegionRects.map((rect) => rect.top))
      : window.innerHeight - floatingViewportInsetPx;
    const rows = [...avoidanceRoot.querySelectorAll<HTMLElement>(feedbackRowSelector)]
      .map((row) => ({ row, rect: visibleRect(row) }))
      .filter((entry): entry is { row: HTMLElement; rect: DOMRect } => entry.rect !== null)
      .filter((entry) => entry.rect.bottom <= scrollBoundaryTop + 0.5)
      .sort((left, right) => left.rect.top - right.rect.top);

    let dialogControlSafeCandidate: FloatingFeedbackRect | null = null;
    for (const { row } of rows) {
      const candidates = rowCandidates(row, feedbackRect, targetRects);
      if (!candidates) continue;

      for (const candidate of candidates.strict) {
        if (isAllowed(candidate, candidates.occupied)) {
          updatePosition(toFloatingPosition(candidate));
          return;
        }
      }

      if (dialog && !dialogControlSafeCandidate) {
        dialogControlSafeCandidate = candidates.controlSafe.find((candidate) => (
          withinViewport(candidate)
          && !overlapsAny(candidate, targetRects)
          && !overlapsAny(candidate, candidates.controls)
          && !overlapsAny(candidate, scrollRegionRects)
        )) ?? null;
      }
    }

    // 先搜索完滚动区上方所有固定行的真实空白；都没有时，对话框才使用
    // 最靠上的控件安全区。这样可保留关闭按钮兜底，也不会进入滚动正文。
    if (dialogControlSafeCandidate) {
      updatePosition(toFloatingPosition(dialogControlSafeCandidate));
      return;
    }

    // 移动端固定导航不是提示候选行。没有其他固定行空白可用时，从导航
    // 下方开始保留右上角兜底；桌面端则使用 CSS 中的原始右上角位置。
    // 兜底允许遮挡页面内容，但不会为了避让继续向下搜索滚动区。
    if (mobileNavigationRect) {
      updatePosition({
        top: mobileNavigationRect.bottom + floatingCollisionGapPx,
        right: null
      });
      return;
    }
    updatePosition(null);
  }, [enabled]);

  useLayoutEffect(() => {
    if (!enabled) return;
    const scheduleMeasure = () => {
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = requestAnimationFrame(() => {
        animationFrameRef.current = null;
        measure();
      });
    };

    measure();
    window.addEventListener("resize", scheduleMeasure);
    window.addEventListener("scroll", scheduleMeasure, true);
    const mutationObserver = new MutationObserver(scheduleMeasure);
    mutationObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "disabled"]
    });
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    if (elementRef.current) resizeObserver?.observe(elementRef.current);

    return () => {
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("scroll", scheduleMeasure, true);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [enabled, feedbackKey, measure]);

  return { elementRef, position };
}

export function ActionFeedback({
  feedback,
  placement,
  autoDismissMs = actionFeedbackDefaultDurationMs,
  onClose
}: {
  feedback: ActionFeedbackState;
  placement: ActionFeedbackPlacement;
  autoDismissMs?: number | null;
  onClose?: () => void;
}) {
  const text = feedback.text.trim();
  const feedbackKey = `${feedback.id}\u0000${feedback.status}\u0000${text}`;
  const [dismissedKey, setDismissedKey] = useState("");
  const pending = feedback.status === "pending";
  // 进行中状态跟随实际操作生命周期，由成功或失败状态替换；只有终态提示参与自动关闭倒计时。
  const timed = !pending && autoDismissMs !== null && autoDismissMs > 0;
  const visible = Boolean(text) && dismissedKey !== feedbackKey;
  const floatingPosition = useFloatingFeedbackPosition(placement === "floating" && visible, feedbackKey);

  const dismiss = () => {
    setDismissedKey(feedbackKey);
    onClose?.();
  };

  const finishCountdown = (event: AnimationEvent<HTMLSpanElement>) => {
    if (timed && event.animationName === "action-feedback-countdown") dismiss();
  };

  if (!visible) return null;

  const style: ActionFeedbackStyle = timed
    ? { "--action-feedback-duration": `${autoDismissMs}ms` }
    : {};
  if (placement === "floating" && floatingPosition.position) {
    style.top = floatingPosition.position.top;
    if (floatingPosition.position.right !== null) {
      style.right = floatingPosition.position.right;
    }
  }

  const element = (
    <div
      ref={floatingPosition.elementRef}
      className={`action-feedback action-feedback-${feedback.status} is-${placement}`}
      data-feedback-placement={placement}
      role={feedback.status === "error" ? "alert" : "status"}
      style={style}
      title={feedback.status === "error" ? text : undefined}
    >
      {(pending || timed) && (
        <span
          key={feedbackKey}
          aria-hidden="true"
          className={`action-feedback-progress${timed ? " is-timed" : " is-pending"}`}
          onAnimationEnd={finishCountdown}
        />
      )}
      <div className="action-feedback-content">
        {text.startsWith("{") ? <pre>{feedback.text}</pre> : <span>{feedback.text}</span>}
      </div>
      <button
        type="button"
        className="action-feedback-close"
        aria-label="关闭提示"
        title="关闭提示"
        onClick={dismiss}
      >
        <Icon name="close-line" />
      </button>
    </div>
  );

  return placement === "floating" ? createPortal(element, document.body) : element;
}
