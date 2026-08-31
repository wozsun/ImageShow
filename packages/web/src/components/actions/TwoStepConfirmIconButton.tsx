import { AdminIcon, type AdminIconName } from "../icon/AdminIcon.js";
import { useTwoStepConfirmation } from "../../hooks/useTwoStepConfirmation.js";

type TwoStepConfirmIconButtonProps = {
  className?: string;
  idleIcon: AdminIconName;
  confirmIcon: AdminIconName;
  busyIcon?: AdminIconName;
  idleLabel: string;
  confirmLabel: string;
  busyLabel?: string;
  idleTitle?: string;
  confirmTitle?: string;
  busyTitle?: string;
  disabled?: boolean;
  busy?: boolean;
  onArm?: () => boolean | void;
  onConfirm: () => void;
};

/**
 * 用第二次点击提交高风险图标操作；焦点或指针离开按钮即取消确认。
 */
export function TwoStepConfirmIconButton({
  className = "",
  idleIcon,
  confirmIcon,
  busyIcon,
  idleLabel,
  confirmLabel,
  busyLabel = idleLabel,
  idleTitle = idleLabel,
  confirmTitle = confirmLabel,
  busyTitle = busyLabel,
  disabled = false,
  busy = false,
  onArm,
  onConfirm
}: TwoStepConfirmIconButtonProps) {
  const confirmation = useTwoStepConfirmation<HTMLButtonElement>({
    disabled,
    busy
  });
  const active = confirmation.armed;
  const label = busy ? busyLabel : active ? confirmLabel : idleLabel;
  const title = busy ? busyTitle : active ? confirmTitle : idleTitle;

  return (
    <button
      ref={confirmation.targetRef}
      className={[
        "two-step-confirm-icon-button",
        active ? "is-armed" : "",
        className
      ].filter(Boolean).join(" ")}
      type="button"
      title={title}
      aria-label={label}
      aria-pressed={active}
      aria-busy={busy || undefined}
      disabled={disabled}
      onBlur={confirmation.onBlur}
      onClick={() => {
        confirmation.activate(() => onArm?.(), onConfirm);
      }}
    >
      <AdminIcon name={busy && busyIcon
        ? busyIcon
        : active
          ? confirmIcon
          : idleIcon} />
    </button>
  );
}
