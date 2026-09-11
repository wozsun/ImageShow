import { useEffect, useRef, useState } from "react";
import { SplitActionButton } from "../actions/SplitActionButton.js";
import { ConfirmDialog } from "../feedback/ConfirmDialog.js";
import type {
  ClearableImageAttribute,
  ImageAttributeClearPlan,
  PrepareImageAttributeClear
} from "../../lib/image-draft.js";

const attributeLabels = { theme: "主题", tags: "标签", author: "作者", all: "主题、标签和作者" } as const;

export function WorkflowAttributeActions({
  disabled,
  ready,
  scopeLabel,
  onApply,
  onPrepareClear
}: {
  disabled: boolean;
  ready: boolean;
  scopeLabel: string;
  onApply: () => void;
  onPrepareClear: PrepareImageAttributeClear;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [confirmation, setConfirmation] = useState<{
    field: ClearableImageAttribute;
    plan: ImageAttributeClearPlan;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => () => confirmation?.plan.dispose?.(), [confirmation]);

  const select = (field: ClearableImageAttribute) => {
    const plan = onPrepareClear(field);
    if (!plan) return;
    setError("");
    setConfirmation({ field, plan });
  };
  return (
    <>
      <SplitActionButton
        className="workflow-attribute-actions"
        mainClassName={`apply-to-all-button${ready ? " is-ready" : ""}`}
        menuLabel="更多批量属性操作"
        menuTriggerRef={triggerRef}
        disabled={disabled}
        directMain
        onActivate={onApply}
        items={(Object.keys(attributeLabels) as ClearableImageAttribute[]).map((field) => ({
          id: field,
          label: field === "all" ? "清空以上全部" : `清空全部${attributeLabels[field]}`,
          onSelect: () => select(field)
        }))}
      >应用到全部</SplitActionButton>
      {confirmation && (
        <ConfirmDialog
          title={confirmation.field === "all" ? "清空全部分类属性" : `清空全部${attributeLabels[confirmation.field]}`}
          description={`将清空${scopeLabel}中本次选定的${confirmation.plan.maximumCount ? "最多 " : ""}${confirmation.plan.count} ${confirmation.plan.maximumCount ? "个任务" : "张图片"}的${attributeLabels[confirmation.field]}。仅修改${confirmation.field === "all" ? "这三项" : "这一项"}属性，其他图片信息和分类词条保留。${confirmation.plan.maximumCount ? "已提交、已移除或已锁定的任务会跳过；之后加入的任务不受影响。" : "保存后生效，保存前可通过“复原”撤销。"}`}
          confirmLabel="确认清空"
          confirmDisabled={confirmation.plan.count === 0}
          confirmIcon="delete-bin-2-line"
          pendingLabel="清空中"
          successLabel="已清空"
          errorMessage={error}
          returnFocusRef={triggerRef}
          onClose={() => setConfirmation(null)}
          onConfirm={async () => {
            setError("");
            try {
              await confirmation.plan.apply();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "清空失败，请重试");
              return false;
            }
            return true;
          }}
        />
      )}
    </>
  );
}
