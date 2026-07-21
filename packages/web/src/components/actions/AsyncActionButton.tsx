import type { ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "../icon/Icon.js";
import type { AsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";

type AsyncActionPresentation = Record<
  AsyncActionStatus,
  { icon: IconName; label: string }
>;

const asyncActionStatuses: AsyncActionStatus[] = [
  "idle",
  "pending",
  "success",
  "error"
];

type AsyncActionButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> & {
  status: AsyncActionStatus;
  presentation: AsyncActionPresentation;
};

/**
 * 固定文案宽度的异步操作按钮。所有状态文案占用同一网格单元，状态切换只改变
 * 可见内容和配色，不会改变按钮宽度或相邻控件位置。
 */
export function AsyncActionButton({
  status,
  presentation,
  className = "",
  title,
  "aria-label": ariaLabel,
  ...buttonProps
}: AsyncActionButtonProps) {
  const current = presentation[status];
  const classes = ["async-action-button", `is-${status}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      {...buttonProps}
      className={classes}
      title={status === "idle" && title ? title : current.label}
      aria-label={ariaLabel
        ? status === "idle" ? ariaLabel : `${ariaLabel}，${current.label}`
        : current.label}
    >
      <Icon name={current.icon} />
      <span className="async-action-label-slot" aria-live="polite" aria-atomic="true">
        {asyncActionStatuses.map((candidate) => (
          <span
            key={candidate}
            className={`async-action-label${candidate === status ? "" : " is-hidden"}`}
            aria-hidden={candidate !== status}
          >
            {presentation[candidate].label}
          </span>
        ))}
      </span>
    </button>
  );
}
