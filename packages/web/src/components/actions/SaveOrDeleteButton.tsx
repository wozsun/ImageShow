import { AsyncActionButton, type AsyncActionPresentation } from "./AsyncActionButton.js";
import type { AsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";

const savePresentation = {
  pending: { icon: "save-3-line", label: "保存中" },
  success: { icon: "check-line", label: "已保存" },
  error: { icon: "close-line", label: "保存失败" }
} as const;

/** 条目的操作键：显示名有改动或保存反馈未结束时为保存，否则为删除（无删除权限时隐藏）。 */
export function SaveOrDeleteButton({
  itemLabel,
  status,
  dirty,
  canDelete,
  disabled,
  onSave,
  onDelete
}: {
  itemLabel: string;
  status: AsyncActionStatus;
  dirty: boolean;
  canDelete: boolean;
  disabled: boolean;
  onSave: () => void;
  onDelete: () => void;
}) {
  const saveAction = dirty || status !== "idle";
  if (!canDelete && !saveAction) return null;
  const presentation: AsyncActionPresentation = {
    ...savePresentation,
    idle: saveAction
      ? { icon: "save-3-line", label: "保存" }
      : { icon: "delete-bin-6-line", label: "删除" }
  };
  return (
    <AsyncActionButton
      type="button"
      className={`icon vocabulary-action-button ${saveAction ? "button" : "danger-button is-subtle"}`}
      status={status}
      presentation={presentation}
      aria-label={`${saveAction ? "保存" : "删除"}${itemLabel}`}
      disabled={disabled || (saveAction && !dirty)}
      onClick={() => {
        if (saveAction) {
          if (dirty) onSave();
        } else {
          onDelete();
        }
      }}
    />
  );
}
