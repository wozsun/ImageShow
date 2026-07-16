type LabeledSwitchProps = {
  checked: boolean;
  checkedLabel: string;
  uncheckedLabel: string;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
  className?: string;
  disabled?: boolean;
};

/**
 * 二态文字开关：滑块占据一侧，另一侧展示当前状态。
 *
 * 状态含义和持久化由调用方管理，因此图片密度、浅色/深色主题等二态设置都可以复用。
 */
export function LabeledSwitch({
  checked,
  checkedLabel,
  uncheckedLabel,
  ariaLabel,
  onChange,
  className = "",
  disabled = false,
}: LabeledSwitchProps) {
  const currentLabel = checked ? checkedLabel : uncheckedLabel;
  const classes = ["labeled-switch", "pressable", checked ? "is-checked" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${ariaLabel}：${currentLabel}`}
      title={`${ariaLabel}：${currentLabel}`}
      className={classes}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="labeled-switch-label">{currentLabel}</span>
      <span className="labeled-switch-thumb" aria-hidden="true" />
    </button>
  );
}
