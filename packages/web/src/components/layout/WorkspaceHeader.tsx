import type { ReactNode } from "react";
import {
  ActionFeedbackRegion,
  type ActionFeedbackTarget
} from "../feedback/ActionFeedbackRegion.js";

type WorkspaceHeaderProps = {
  title: ReactNode;
  description: ReactNode;
  feedbackTarget?: ActionFeedbackTarget;
  actions?: ReactNode;
  actionsClassName?: string;
};

/** 后台工作区页头：标题、反馈与操作组各有独立 Grid 轨道。 */
export function WorkspaceHeader({
  title,
  description,
  feedbackTarget,
  actions,
  actionsClassName = ""
}: WorkspaceHeaderProps) {
  const hasActions = actions !== undefined && actions !== null;
  const headerClasses = [
    "workspace-head",
    "workspace-grid-head",
    hasActions ? "has-actions" : ""
  ].filter(Boolean).join(" ");
  const actionClasses = ["workspace-header-actions", actionsClassName]
    .filter(Boolean)
    .join(" ");
  const feedbackRegion = feedbackTarget ? (
    <ActionFeedbackRegion
      target={feedbackTarget}
      variant="page"
    />
  ) : null;

  return (
    <header className={headerClasses}>
      <h1>{title}</h1>
      <p>{description}</p>
      {feedbackRegion}
      {hasActions && <div className={actionClasses}>{actions}</div>}
    </header>
  );
}
