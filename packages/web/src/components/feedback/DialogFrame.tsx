import {
  useCallback,
  useRef,
  type ReactNode,
  type RefObject
} from "react";
import { useAnimatedClose } from "../../hooks/useAnimatedClose.js";
import { useBodyScrollLock } from "../../hooks/useBodyScrollLock.js";
import { useDialogFocus } from "../../hooks/useDialogFocus.js";
import { DialogPortalTargetContext } from "./DialogPortalContext.js";

type DialogFrameControls = {
  requestClose: (afterClose?: () => void) => void;
};

export function DialogFrame({
  className,
  titleId,
  descriptionId,
  ariaLabel,
  busy = false,
  paused = false,
  initialFocusRef,
  returnFocusRef,
  onClose,
  children
}: {
  className: string;
  titleId?: string;
  descriptionId?: string;
  ariaLabel?: string;
  busy?: boolean;
  paused?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: (controls: DialogFrameControls) => ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { closing, requestClose: requestAnimatedClose, onAnimationEnd } = useAnimatedClose(onClose);
  const requestClose = useCallback((afterClose?: () => void) => {
    if (!busy) requestAnimatedClose(afterClose);
  }, [busy, requestAnimatedClose]);

  useBodyScrollLock();
  useDialogFocus({
    containerRef,
    initialFocusRef,
    returnFocusRef,
    onEscape: requestClose,
    paused
  });

  return (
    <div
      ref={containerRef}
      className={`${className} ${closing ? "is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-label={titleId ? undefined : ariaLabel}
      tabIndex={-1}
      onAnimationEnd={onAnimationEnd}
    >
      <DialogPortalTargetContext.Provider value={containerRef}>
        {children({
          requestClose
        })}
      </DialogPortalTargetContext.Provider>
    </div>
  );
}
