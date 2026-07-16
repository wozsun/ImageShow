import { useRef } from "react";
import { Icon, type IconName } from "../icon/Icon.js";
import { useAnimatedClose } from "../../hooks/useAnimatedClose.js";
import { useBodyScrollLock } from "../../hooks/useBodyScrollLock.js";
import { useDialogFocus } from "../../hooks/useDialogFocus.js";

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busy = false,
  danger = true,
  confirmIcon = "delete-bin-6-line",
  onClose,
  onConfirm
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  confirmIcon?: IconName;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const exit = useAnimatedClose(onClose);
  const formRef = useRef<HTMLFormElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  useBodyScrollLock();
  useDialogFocus({
    containerRef: formRef,
    initialFocusRef: cancelButtonRef,
    onEscape: () => { if (!busy) exit.requestClose(); },
  });
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
        onSubmit={async (event) => { event.preventDefault(); await onConfirm(); exit.requestClose(); }}
      >
        <header><div><h2>{title}</h2><p>{description}</p></div></header>
        <footer>
          <button ref={cancelButtonRef} type="button" disabled={busy} onClick={() => exit.requestClose()}>取消</button>
          <button className={danger ? "danger-button" : "button"} type="submit" disabled={busy}>
            <Icon name={confirmIcon} />{busy ? "处理中…" : confirmLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}
