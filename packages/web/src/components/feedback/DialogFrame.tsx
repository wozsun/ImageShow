import {
  useCallback,
  useRef,
  type ReactNode,
  type RefObject
} from "react";
import { useAnimatedClose } from "../../hooks/useAnimatedClose.js";
import { usePageScrollLock } from "../../hooks/usePageScrollLock.js";
import { useDialogFocus } from "../../hooks/useDialogFocus.js";
import { DialogLayerPortal } from "./DialogLayerPortal.js";
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
  animateClose = true,
  closeOnBackdrop = false,
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
  animateClose?: boolean;
  closeOnBackdrop?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: (controls: DialogFrameControls) => ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { closing, requestClose: requestAnimatedClose, onAnimationEnd } = useAnimatedClose(onClose);
  const requestClose = useCallback((afterClose?: () => void) => {
    if (busy) return;
    if (animateClose) {
      requestAnimatedClose(afterClose);
      return;
    }
    (afterClose ?? onClose)();
  }, [animateClose, busy, onClose, requestAnimatedClose]);

  usePageScrollLock();
  useDialogFocus({
    containerRef,
    initialFocusRef,
    returnFocusRef,
    onEscape: requestClose,
    paused
  });

  const frame = (
    <div
      ref={containerRef}
      className={`${className} ${closing ? "is-closing" : ""}`}
      data-dialog-frame=""
      data-admin-dialog=""
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-label={titleId ? undefined : ariaLabel}
      tabIndex={-1}
      onPointerDown={closeOnBackdrop
        ? (event) => {
            if (event.target === event.currentTarget) requestClose();
          }
        : undefined}
      onAnimationEnd={onAnimationEnd}
    >
      <DialogPortalTargetContext.Provider value={containerRef}>
        {children({
          requestClose
        })}
      </DialogPortalTargetContext.Provider>
    </div>
  );

  // 最外层表单弹窗与被冻结的 #root 并列，弹窗及其输入控件不会再落入 fixed
  // 祖先的 WebKit 命中坐标系。嵌套弹窗留在父弹窗中，继续继承既有层级与样式。
  return <DialogLayerPortal>{frame}</DialogLayerPortal>;
}
