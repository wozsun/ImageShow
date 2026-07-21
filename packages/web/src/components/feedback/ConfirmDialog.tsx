import { useRef } from "react";
import type { IconName } from "../icon/Icon.js";
import { AsyncActionButton } from "../actions/AsyncActionButton.js";
import { useAnimatedClose } from "../../hooks/useAnimatedClose.js";
import { useBodyScrollLock } from "../../hooks/useBodyScrollLock.js";
import { useDialogFocus } from "../../hooks/useDialogFocus.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";

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
  const exit = useAnimatedClose(onClose);
  const confirmStatus = useAsyncActionStatus({ successDurationMs: null });
  const formRef = useRef<HTMLFormElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const blocked = busy || confirmStatus.pending;
  const confirmPresentation = {
    idle: { icon: confirmIcon, label: confirmLabel },
    pending: { icon: confirmIcon, label: pendingLabel },
    success: { icon: "check-line", label: successLabel },
    error: { icon: "close-line", label: errorLabel }
  } as const;
  useBodyScrollLock();
  useDialogFocus({
    containerRef: formRef,
    initialFocusRef: cancelButtonRef,
    onEscape: () => { if (!blocked) exit.requestClose(); },
  });
  const submit = async () => {
    try {
      const succeeded = await confirmStatus.run(async () => {
        const result = await onConfirm();
        return result !== false;
      });
      if (succeeded) exit.requestClose();
    } catch {
      // 调用方负责记录业务错误；按钮保留失败状态并允许直接重试。
    }
  };
  return (
    <div
      className={`modal edit-modal confirm-dialog ${exit.closing ? "is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onAnimationEnd={exit.onAnimationEnd}
    >
      <form
        ref={formRef}
        tabIndex={-1}
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <header><div><h2>{title}</h2><p>{description}</p></div></header>
        <footer>
          <button ref={cancelButtonRef} type="button" disabled={blocked} onClick={() => exit.requestClose()}>取消</button>
          <AsyncActionButton
            className={danger ? "danger-button" : "button"}
            type="submit"
            status={confirmStatus.status}
            presentation={confirmPresentation}
            disabled={blocked}
          />
        </footer>
      </form>
    </div>
  );
}
