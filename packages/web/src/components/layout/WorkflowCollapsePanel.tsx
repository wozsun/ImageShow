import { useId, type ReactNode } from "react";
import { AnchoredMenuDismissSignalContext } from "../../hooks/useAnchoredMenu.js";
import { useDismissiblePanel } from "../../hooks/useDismissiblePanel.js";
import {
  mobileViewportMediaQuery,
  useMediaQuery
} from "../../hooks/useMediaQuery.js";
import { DirectActivationButton } from "../feedback/DirectActivationButton.js";
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
      className={`workflow-collapse-panel ${className}${expanded ? " is-expanded" : ""}${disclosure.motionEnabled ? " is-motion-enabled" : ""}`}
    >
      <DirectActivationButton
        ref={disclosure.triggerRef}
        type="button"
        className="workflow-collapse-toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        pointerFocus={expanded ? "release-after-activation" : "target"}
        onActivate={() => disclosure.setOpen(!expanded)}
      >
        <span>{title}</span>
        <small>{summary}</small>
        <Icon name="arrow-down-s-line" />
      </DirectActivationButton>
      <AnchoredMenuDismissSignalContext.Provider
        value={disclosure.menuDismissSignal}
      >
        <div
          ref={disclosure.panelRef}
          id={contentId}
          className={`workflow-collapse-content ${contentClassName}`}
          aria-hidden={disclosure.panelHidden}
          inert={disclosure.panelHidden}
        >
          {children}
        </div>
      </AnchoredMenuDismissSignalContext.Provider>
    </div>
  );
}
