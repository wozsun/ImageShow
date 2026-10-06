export type ActionFeedbackStatus = "pending" | "success" | "error";

export type ActionFeedbackState = {
  id: number;
  text: string;
  status: ActionFeedbackStatus;
};

let actionFeedbackSequence = 0;

export function createActionFeedback(
  text: string,
  status: ActionFeedbackStatus
): ActionFeedbackState {
  actionFeedbackSequence += 1;
  return {
    id: actionFeedbackSequence,
    text,
    status
  };
}
