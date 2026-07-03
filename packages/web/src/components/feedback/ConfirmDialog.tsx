import { Icon, type IconName } from "../icon/Icon.js";
import { useAnimatedClose } from "../../hooks/useAnimatedClose.js";
import { useBodyScrollLock } from "../../hooks/useBodyScrollLock.js";

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
  useBodyScrollLock();
  return (
    <div
      className={`modal edit-modal confirm-dialog ${exit.closing ? "is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onAnimationEnd={exit.onAnimationEnd}
    >
      <form
        onSubmit={async (event) => { event.preventDefault(); await onConfirm(); exit.requestClose(); }}
      >
        <header><div><h2>{title}</h2><p>{description}</p></div></header>
        <footer>
          <button type="button" disabled={busy} onClick={() => exit.requestClose()}>取消</button>
          <button className={danger ? "danger-button" : "button"} type="submit" disabled={busy}>
            <Icon name={confirmIcon} />{busy ? "处理中…" : confirmLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}
