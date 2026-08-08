import { useEffect, useRef, useState } from "react";
import { AdminIcon, type AdminIconName } from "../icon/AdminIcon.js";

type TwoStepConfirmIconButtonProps = {
  className?: string;
  idleIcon: AdminIconName;
  confirmIcon: AdminIconName;
  idleLabel: string;
  confirmLabel: string;
  idleTitle?: string;
  confirmTitle?: string;
  disabled?: boolean;
  busy?: boolean;
  onArm?: () => void;
  onConfirm: () => void;
};

/**
 * 用第二次点击提交高风险图标操作；焦点或指针离开按钮即取消确认。
 */
export function TwoStepConfirmIconButton({
  className = "",
  idleIcon,
  confirmIcon,
  idleLabel,
  confirmLabel,
  idleTitle = idleLabel,
  confirmTitle = confirmLabel,
  disabled = false,
  busy = false,
  onArm,
  onConfirm
}: TwoStepConfirmIconButtonProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const disarmOutsideButton = (event: PointerEvent) => {
      if (!buttonRef.current?.contains(event.target as Node)) {
        setArmed(false);
      }
    };
    document.addEventListener("pointerdown", disarmOutsideButton, true);
    return () => {
      document.removeEventListener("pointerdown", disarmOutsideButton, true);
    };
  }, [armed]);

  useEffect(() => {
    if (disabled || busy) setArmed(false);
  }, [busy, disabled]);

  const active = armed && !disabled && !busy;
  const label = active ? confirmLabel : idleLabel;
  const title = active ? confirmTitle : idleTitle;

  return (
    <button
      ref={buttonRef}
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
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!active) {
          onArm?.();
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    >
      <AdminIcon name={active ? confirmIcon : idleIcon} />
    </button>
  );
}
