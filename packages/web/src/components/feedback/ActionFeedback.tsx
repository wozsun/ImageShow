import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent
} from "react";
import { defaultUiFeedbackDurationMs } from "../../lib/ui/async-action-timing.js";
import { Icon } from "../icon/Icon.js";

export type ActionFeedbackStatus = "info" | "pending" | "success" | "error";

export type ActionFeedbackState = {
  id: number;
  text: string;
  status: ActionFeedbackStatus;
  /**
   * 终态消息的自动关闭时间。省略时使用三秒，null 或非正数表示不自动关闭。
   * pending 始终跟随业务操作生命周期，不会因为此配置而自动关闭。
   */
  autoDismissMs?: number | null;
};

const actionFeedbackExitDurationMs = 110;

let actionFeedbackSequence = 0;

export function createActionFeedback(
  text: string,
  status: ActionFeedbackStatus,
  options: Pick<ActionFeedbackState, "autoDismissMs"> = {}
): ActionFeedbackState {
  actionFeedbackSequence += 1;
  return {
    id: actionFeedbackSequence,
    text,
    status,
    ...options
  };
}

type ActionFeedbackStyle = CSSProperties & {
  "--action-feedback-duration"?: string;
};

function resolveAutoDismissMs(feedback: ActionFeedbackState) {
  if (feedback.autoDismissMs !== undefined) return feedback.autoDismissMs;
  return defaultUiFeedbackDurationMs;
}

/**
 * 纯展示组件。区域归属和 portal 路由由 ActionFeedbackOutlet 负责；这里仅管理
 * 单条消息的视觉、倒计时、暂停与关闭生命周期。
 */
export function ActionFeedback({
  feedback,
  onClose
}: {
  feedback: ActionFeedbackState;
  onClose?: () => void;
}) {
  const text = feedback.text.trim();
  const feedbackKey = `${feedback.id}\u0000${feedback.status}\u0000${text}`;
  const dismissAfterMs = resolveAutoDismissMs(feedback);
  const pending = feedback.status === "pending";
  const timed = !pending && dismissAfterMs !== null && dismissAfterMs > 0;

  const [dismissedKey, setDismissedKey] = useState("");
  const [closingKey, setClosingKey] = useState("");
  const closingKeyRef = useRef("");
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const visible = Boolean(text) && dismissedKey !== feedbackKey;
  const closing = closingKey === feedbackKey;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerStartedAtRef = useRef<number | null>(null);
  const timerKeyRef = useRef("");
  const remainingMsRef = useRef(0);

  const dismiss = useCallback(() => {
    if (closingKeyRef.current === feedbackKey) return;
    closingKeyRef.current = feedbackKey;
    setClosingKey(feedbackKey);
  }, [feedbackKey]);

  useEffect(() => {
    if (!closing) return;

    const exitTimer = setTimeout(() => {
      closingKeyRef.current = "";
      setDismissedKey(feedbackKey);
      setClosingKey("");
      onClose?.();
    }, actionFeedbackExitDurationMs);

    return () => clearTimeout(exitTimer);
  }, [closing, feedbackKey, onClose]);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    const stopElapsedClock = () => {
      if (timerStartedAtRef.current === null) return;
      remainingMsRef.current = Math.max(
        0,
        remainingMsRef.current - (Date.now() - timerStartedAtRef.current)
      );
      timerStartedAtRef.current = null;
    };

    clearTimer();

    if (!visible || closing || !timed || dismissAfterMs === null) {
      timerKeyRef.current = "";
      remainingMsRef.current = 0;
      timerStartedAtRef.current = null;
      return clearTimer;
    }

    const countdownKey = `${feedbackKey}\u0000${dismissAfterMs}`;
    if (timerKeyRef.current !== countdownKey) {
      timerKeyRef.current = countdownKey;
      remainingMsRef.current = dismissAfterMs;
      timerStartedAtRef.current = null;
    }

    if (!paused) {
      timerStartedAtRef.current = Date.now();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        timerStartedAtRef.current = null;
        remainingMsRef.current = 0;
        dismiss();
      }, remainingMsRef.current);
    }

    return () => {
      clearTimer();
      stopElapsedClock();
    };
  }, [closing, dismiss, dismissAfterMs, feedbackKey, paused, timed, visible]);

  const leaveFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setFocused(false);
    }
  };

  if (!visible) return null;

  const style: ActionFeedbackStyle = timed
    ? { "--action-feedback-duration": `${dismissAfterMs}ms` }
    : {};

  return (
    <div
      className={`action-feedback action-feedback-${feedback.status}${paused ? " is-countdown-paused" : ""}${closing ? " is-closing" : ""}`}
      data-feedback-id={feedback.id}
      role={feedback.status === "error" ? "alert" : "status"}
      style={style}
      title={text}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={leaveFocus}
    >
      {(pending || timed) && (
        <span
          key={feedbackKey}
          aria-hidden="true"
          className={`action-feedback-progress${timed ? " is-timed" : " is-pending"}`}
        />
      )}
      <div className="action-feedback-content">
        <span>{text}</span>
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
}
