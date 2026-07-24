import { useId, type ReactNode } from "react";
import { AnchoredMenuDismissSignalContext } from "../../hooks/useAnchoredMenu.js";
import { useDismissiblePanel } from "../../hooks/useDismissiblePanel.js";
import {
  mobileViewportMediaQuery,
  useMediaQuery
} from "../../hooks/useMediaQuery.js";
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
  const mobileLayout = useMediaQuery(mobileViewportMediaQuery);
  const disclosure = useDismissiblePanel({
    open: expanded,
    onOpenChange: onExpandedChange,
    enabled: mobileLayout,
    resetKey: mobileLayout
  });

  return (
    <div
      ref={disclosure.rootRef}
      className={`workflow-collapse-panel ${className}${expanded ? " is-expanded" : ""}${disclosure.motionEnabled ? " is-motion-enabled" : ""}`}
    >
      <button
        type="button"
        className="workflow-collapse-toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => disclosure.setOpen(!expanded)}
      >
        <span>{title}</span>
        <small>{summary}</small>
        <Icon name="arrow-down-s-line" />
      </button>
      <AnchoredMenuDismissSignalContext.Provider
        value={disclosure.menuDismissSignal}
      >
        <div
          id={contentId}
          className={`workflow-collapse-content ${contentClassName}`}
          aria-hidden={mobileLayout && !expanded}
          inert={mobileLayout && !expanded}
        >
          {children}
        </div>
      </AnchoredMenuDismissSignalContext.Provider>
    </div>
  );
}
