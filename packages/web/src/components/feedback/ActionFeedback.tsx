export type ActionFeedbackState = {
  text: string;
  status: "pending" | "success" | "error";
};

export function ActionFeedback({ feedback, inline = false }: {
  feedback: ActionFeedbackState;
  inline?: boolean;
}) {
  return (
    <div
      className={`action-feedback${inline ? " is-inline" : ""} ${feedback.status === "success" ? "ok" : feedback.status === "error" ? "error" : ""}`}
      title={feedback.status === "error" ? feedback.text : undefined}
    >
      {feedback.text.trim().startsWith("{") ? <pre>{feedback.text}</pre> : <span>{feedback.text}</span>}
    </div>
  );
}
