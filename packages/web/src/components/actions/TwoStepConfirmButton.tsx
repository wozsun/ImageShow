import { AdminIcon, type AdminIconName } from "../icon/AdminIcon.js";
import { useTwoStepConfirmation } from "../../hooks/useTwoStepConfirmation.js";

type TwoStepConfirmButtonProps = {
  className?: string;
  /** 显示文字时三种文案叠放在同一格中按最宽者占位；否则文案只作为无障碍名称。 */
  showLabel?: boolean;
  idleIcon: AdminIconName;
  confirmIcon: AdminIconName;
  busyIcon?: AdminIconName;
  idleLabel: string;
  confirmLabel: string;
  busyLabel?: string;
  /** 纯图标按钮的悬停提示，缺省使用对应文案。 */
  idleTitle?: string;
  confirmTitle?: string;
  busyTitle?: string;
  disabled?: boolean;
  busy?: boolean;
  invalidationKey?: string;
  onArm?: () => boolean | void;
  onDisarm?: () => void;
  onConfirm: () => void;
};

/**
 * 用第二次点击提交高风险操作；焦点或指针离开按钮、invalidationKey 变化即取消确认。
 */
export function TwoStepConfirmButton({
  className = "",
  showLabel = false,
  idleIcon,
  confirmIcon,
  busyIcon = idleIcon,
  idleLabel,
  confirmLabel,
  busyLabel = idleLabel,
  idleTitle = idleLabel,
  confirmTitle = confirmLabel,
  busyTitle = busyLabel,
  disabled = false,
  busy = false,
  invalidationKey,
  onArm,
  onDisarm,
  onConfirm
}: TwoStepConfirmButtonProps) {
  const confirmation = useTwoStepConfirmation<HTMLButtonElement>({
    disabled,
    busy,
    invalidationKey,
    onDisarm
  });
  const armed = confirmation.armed;
  const labels = [idleLabel, confirmLabel, busyLabel];
  const state = busy ? 2 : armed ? 1 : 0;

  return (
    <button
      ref={confirmation.targetRef}
      className={[
        "two-step-confirm-button",
        armed ? "is-armed" : "",
        className
      ]
        .filter(Boolean)
        .join(" ")}
      type="button"
      title={showLabel ? undefined : [idleTitle, confirmTitle, busyTitle][state]}
      aria-label={labels[state]}
      aria-pressed={armed}
      aria-busy={busy || undefined}
      disabled={disabled}
      onBlur={confirmation.onBlur}
      onClick={() => {
        confirmation.activate(() => onArm?.(), onConfirm);
      }}
    >
      <AdminIcon name={[idleIcon, confirmIcon, busyIcon][state]!} />
      {showLabel && (
        <span className="btn-label-slot">
          {labels.map((text, index) => (
            <span
              key={index}
              className={`btn-label-cell${index === state ? "" : " is-hidden"}`}
              aria-hidden={index !== state}
            >
              {text}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}
