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
