import { useEffect, useState } from "react";
import { defaultUiFeedbackDurationMs } from "../../lib/ui/async-action-timing.js";
import type { ActionFeedbackState } from "../../lib/ui/action-feedback.js";

const actionFeedbackExitDurationMs = 110;
// 错误需要读完原因再处理，比成功提示多停留一倍时间。
const errorFeedbackDurationMs = 2 * defaultUiFeedbackDurationMs;

function feedbackDurationMs(feedback: ActionFeedbackState) {
  if (feedback.status === "pending") return null;
  return feedback.status === "error"
    ? errorFeedbackDurationMs
    : defaultUiFeedbackDurationMs;
}

/**
 * 纯展示组件。区域归属和 portal 路由由 ActionFeedbackOutlet 负责；这里只管理
 * 单条消息的文字、自动消失与退出动画。pending 跟随业务操作，由调用方替换或清除。
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
  const dismissAfterMs = feedbackDurationMs(feedback);
  const [dismissedKey, setDismissedKey] = useState("");
  const [closingKey, setClosingKey] = useState("");
  const visible = Boolean(text) && dismissedKey !== feedbackKey;
  const closing = closingKey === feedbackKey;

  useEffect(() => {
    if (!visible || closing || dismissAfterMs === null) return;
    const dismissTimer = setTimeout(() => setClosingKey(feedbackKey), dismissAfterMs);
    return () => clearTimeout(dismissTimer);
  }, [closing, dismissAfterMs, feedbackKey, visible]);

  useEffect(() => {
    if (!closing) return;
    const exitTimer = setTimeout(() => {
      setDismissedKey(feedbackKey);
      setClosingKey("");
      onClose?.();
    }, actionFeedbackExitDurationMs);
    return () => clearTimeout(exitTimer);
  }, [closing, feedbackKey, onClose]);

  if (!visible) return null;

  return (
    <div
      className={`action-feedback action-feedback-${feedback.status}${closing ? " is-closing" : ""}`}
      data-feedback-id={feedback.id}
      role={feedback.status === "error" ? "alert" : "status"}
      title={text}
    >
      {text}
    </div>
  );
}
