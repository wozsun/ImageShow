import type { ReactNode } from "react";
import {
  ActionFeedbackRegion,
  type ActionFeedbackTarget
} from "../feedback/ActionFeedbackRegion.js";
import { WorkspaceToolbar } from "./WorkspaceToolbar.js";

type WorkspaceHeaderProps = {
  title: ReactNode;
  description: ReactNode;
  feedbackTarget?: ActionFeedbackTarget;
  titleAccessory?: ReactNode;
  actions?: ReactNode;
  actionsClassName?: string;
  toolbarRow?: ReactNode;
};

/**
 * 后台工作区页头。标题、描述与标题旁的附件组成固定的标题区，页面反馈临时替换描述行；操作组
 * 桌面位于标题右侧，页面工具栏位于页头下方。窄屏标题区吸顶，操作组与页面工具栏合为一整块
 * 操作区，随滚动显隐（见 useWorkspaceToolbarCollapse）。标题区与操作区是兄弟节点，桌面上二者的
 * 包装层都不参与布局，各项仍按页头网格排布，两端 DOM 结构一致。
 */
export function WorkspaceHeader({
  title,
  description,
  feedbackTarget,
  titleAccessory,
  actions,
  actionsClassName = "",
  toolbarRow
}: WorkspaceHeaderProps) {
  const hasActions = actions !== undefined && actions !== null;
  const hasToolbarRow = toolbarRow !== undefined && toolbarRow !== null;
  const hasAccessory = titleAccessory !== undefined && titleAccessory !== null;
  const headerClasses = [
    "workspace-head",
    "workspace-grid-head",
    hasActions ? "has-actions" : "",
    hasToolbarRow ? "has-toolbar-row" : "",
    hasAccessory ? "has-accessory" : ""
  ]
    .filter(Boolean)
    .join(" ");
  const actionClasses = ["workspace-header-actions", actionsClassName]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={headerClasses}>
      <header className="workspace-pinned" data-workspace-pinned="">
        <h1>{title}</h1>
        {hasAccessory && <div className="workspace-title-accessory">{titleAccessory}</div>}
        <p>{description}</p>
        {feedbackTarget && <ActionFeedbackRegion target={feedbackTarget} />}
      </header>
      {(hasActions || hasToolbarRow) && (
        <WorkspaceToolbar className="workspace-header-toolbar">
          {hasActions && <div className={actionClasses}>{actions}</div>}
          {hasToolbarRow && <div className="workspace-header-toolbar-row">{toolbarRow}</div>}
        </WorkspaceToolbar>
      )}
    </div>
  );
}
