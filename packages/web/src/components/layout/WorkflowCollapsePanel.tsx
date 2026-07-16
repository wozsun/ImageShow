import { useId, type ReactNode } from "react";
import { Icon } from "../icon/Icon.js";

export function WorkflowCollapsePanel({
  className,
  contentClassName,
  title,
  summary,
  expanded,
  onExpandedChange,
  children,
}: {
  className: string;
  contentClassName: string;
  title: string;
  summary: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}) {
  const contentId = useId();

  return (
    <div className={`${className}${expanded ? " is-expanded" : ""}`}>
      <button
        type="button"
        className="workflow-collapse-toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => onExpandedChange(!expanded)}
      >
        <span>{title}</span>
        <small>{summary}</small>
        <Icon name="arrow-down-s-line" />
      </button>
      <div id={contentId} className={contentClassName}>
        {children}
      </div>
    </div>
  );
}
