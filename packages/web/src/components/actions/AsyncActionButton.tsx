import type { ButtonHTMLAttributes, ReactElement } from "react";
import { AdminIcon, type AdminIconName } from "../icon/AdminIcon.js";
import type { AsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";

type AsyncActionPresentationItem = {
  icon?: AdminIconName;
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
 * 固定文案宽度的异步操作按钮。所有状态文案占用同一网格单元，不会改变按钮宽度
 * 或相邻控件位置；pending 保留调用方原有的主次层级，完成结果才使用反馈配色。
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
      <span className="async-action-label-slot" aria-live="polite" aria-atomic="true">
        {asyncActionStatuses.map((candidate) => {
          const item = presentation[candidate];
          const currentState = candidate === status;
          return (
            <span
              key={candidate}
              className={`async-action-state${currentState ? "" : " is-hidden"}`}
              aria-hidden={!currentState}
            >
              {item.icon && (
                currentState
                  ? <AdminIcon name={item.icon} />
                  : <span className="async-action-icon-placeholder" aria-hidden="true" />
              )}
              <span className="async-action-label">{item.label}</span>
            </span>
          );
        })}
      </span>
    </button>
  );
}
