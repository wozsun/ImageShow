import type { ButtonHTMLAttributes, ReactElement } from "react";
import { Icon, type IconName } from "../icon/Icon.js";
import type { AsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";

type AsyncActionPresentationItem = {
  icon?: IconName;
} & (
  | { label: string; ariaLabel?: never }
  | { label: ReactElement; ariaLabel: string }
);

export type AsyncActionPresentation = Record<
  AsyncActionStatus,
  AsyncActionPresentationItem
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
  const currentAriaLabel = typeof current.label === "string"
    ? current.label
    : current.ariaLabel;
  const classes = ["async-action-button", `is-${status}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      {...buttonProps}
      className={classes}
      title={status === "idle" && title ? title : currentAriaLabel}
      aria-label={ariaLabel
        ? status === "idle" ? ariaLabel : `${ariaLabel}，${currentAriaLabel}`
        : currentAriaLabel}
    >
      {current.icon && <Icon name={current.icon} />}
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
