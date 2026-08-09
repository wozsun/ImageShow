import { useRef, useState, type RefObject } from "react";
import type { AdminIconName } from "../icon/AdminIcon.js";
import { AsyncActionButton } from "../actions/AsyncActionButton.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";
import { DialogFrame } from "./DialogFrame.js";

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busy = false,
  confirmDisabled = false,
  requireFinalConfirmation = false,
  finalConfirmationLabel = "再次确认",
  finalConfirmationIcon = "delete-bin-2-line",
  closeOnBackdrop = false,
  danger = true,
  confirmIcon = "delete-bin-6-line",
  pendingLabel = "处理中",
  successLabel = "操作成功",
  errorLabel = "操作失败",
  errorMessage = "",
  returnFocusRef,
  onClose,
  onConfirm
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  requireFinalConfirmation?: boolean;
  finalConfirmationLabel?: string;
  finalConfirmationIcon?: AdminIconName;
  closeOnBackdrop?: boolean;
  danger?: boolean;
  confirmIcon?: AdminIconName;
  pendingLabel?: string;
  successLabel?: string;
  errorLabel?: string;
  errorMessage?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onConfirm: () => Promise<boolean | void>;
}) {
  const confirmStatus = useAsyncActionStatus({ successDurationMs: null });
  const [finalConfirmationArmed, setFinalConfirmationArmed] = useState(false);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const blocked = busy || confirmStatus.pending;
  const finalConfirmationActive = (
    requireFinalConfirmation
    && finalConfirmationArmed
    && !blocked
    && !confirmDisabled
  );
  const displayedStatus = finalConfirmationActive
    ? "idle"
    : confirmStatus.status;
  const confirmPresentation = {
    idle: {
      icon: finalConfirmationActive ? finalConfirmationIcon : confirmIcon,
      label: finalConfirmationActive ? finalConfirmationLabel : confirmLabel
    },
    pending: { icon: confirmIcon, label: pendingLabel },
    success: { icon: "check-line", label: successLabel },
    error: { icon: "close-line", label: errorLabel }
  } as const;
  const submit = async (requestClose: () => void) => {
    try {
      const succeeded = await confirmStatus.run(async () => {
        const result = await onConfirm();
        return result !== false;
      });
      if (succeeded) requestClose();
    } catch {
      // 调用方负责记录业务错误；按钮保留失败状态并允许直接重试。
    }
  };
  return (
    <DialogFrame
      className="modal edit-modal confirm-dialog"
      ariaLabel={title}
      busy={blocked}
      closeOnBackdrop={closeOnBackdrop}
      initialFocusRef={cancelButtonRef}
      returnFocusRef={returnFocusRef}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <form
          tabIndex={-1}
          onSubmit={(event) => {
            event.preventDefault();
            if (requireFinalConfirmation && !finalConfirmationActive) {
              setFinalConfirmationArmed(true);
              return;
            }
            setFinalConfirmationArmed(false);
            void submit(requestClose);
          }}
        >
          <header><div><h2>{title}</h2><p>{description}</p></div></header>
          {errorMessage && (
            <p className="confirm-dialog-error admin-error" role="alert">
              {errorMessage}
            </p>
          )}
          <footer>
            <button ref={cancelButtonRef} type="button" disabled={blocked} onClick={() => requestClose()}>取消</button>
            <AsyncActionButton
              className={[
                danger ? "danger-button" : "button",
                requireFinalConfirmation
                  ? "confirm-dialog-final-confirmation"
                  : "",
                finalConfirmationActive ? "is-armed" : ""
              ].filter(Boolean).join(" ")}
              type="submit"
              status={displayedStatus}
              presentation={confirmPresentation}
              disabled={blocked || confirmDisabled}
              aria-pressed={requireFinalConfirmation
                ? finalConfirmationActive
                : undefined}
              onBlur={() => setFinalConfirmationArmed(false)}
            />
          </footer>
        </form>
      )}
    </DialogFrame>
  );
}
