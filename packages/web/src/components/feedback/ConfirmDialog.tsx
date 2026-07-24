import { useRef } from "react";
import type { IconName } from "../icon/Icon.js";
import { AsyncActionButton } from "../actions/AsyncActionButton.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";
import { DialogFrame } from "./DialogFrame.js";

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busy = false,
  danger = true,
  confirmIcon = "delete-bin-6-line",
  pendingLabel = "处理中",
  successLabel = "操作成功",
  errorLabel = "操作失败",
  onClose,
  onConfirm
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  confirmIcon?: IconName;
  pendingLabel?: string;
  successLabel?: string;
  errorLabel?: string;
  onClose: () => void;
  onConfirm: () => Promise<boolean | void>;
}) {
  const confirmStatus = useAsyncActionStatus({ successDurationMs: null });
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const blocked = busy || confirmStatus.pending;
  const confirmPresentation = {
    idle: { icon: confirmIcon, label: confirmLabel },
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
      initialFocusRef={cancelButtonRef}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <form
          tabIndex={-1}
          onSubmit={(event) => {
            event.preventDefault();
            void submit(requestClose);
          }}
        >
          <header><div><h2>{title}</h2><p>{description}</p></div></header>
          <footer>
            <button ref={cancelButtonRef} type="button" disabled={blocked} onClick={() => requestClose()}>取消</button>
            <AsyncActionButton
              className={danger ? "danger-button" : "button"}
              type="submit"
              status={confirmStatus.status}
              presentation={confirmPresentation}
              disabled={blocked}
            />
          </footer>
        </form>
      )}
    </DialogFrame>
  );
}
