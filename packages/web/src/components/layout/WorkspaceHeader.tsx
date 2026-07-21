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

/** 后台工作区页头：标题与反馈共享稳定首行，描述和操作组使用独立轨道。 */
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
      <div className="workspace-header-title-row">
        <h1>{title}</h1>
        {feedbackRegion}
      </div>
      <p>{description}</p>
      {hasActions && <div className={actionClasses}>{actions}</div>}
    </header>
  );
}
