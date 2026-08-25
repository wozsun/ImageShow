export type UploadCleanupActionId =
  | "duplicates"
  | "uncommitted"
  | "completed";

type UploadCleanupConfirmation = {
  title: string;
  description: (count: number) => string;
  confirmLabel: (count: number) => string;
};

export type UploadCleanupAction = {
  id: UploadCleanupActionId;
  label: string;
  count: number;
  enabled: boolean;
  confirmation?: UploadCleanupConfirmation;
  run: () => void;
};

type UploadCleanupActionDefinition = {
  id: UploadCleanupActionId;
  label: string;
  confirmation?: UploadCleanupConfirmation;
};

const uploadCleanupActionDefinitions: UploadCleanupActionDefinition[] = [
  {
    id: "duplicates",
    label: "清空重复待确认"
  },
  {
    id: "uncommitted",
    label: "清空未提交",
    confirmation: {
      title: "清空未提交任务",
      description: (count) => (
        `将清空当前 ${count} 张未提交图片；仍在处理的任务会被取消，已成功提交的图片不受影响。`
      ),
      confirmLabel: (count) => `清空 ${count} 张`
    }
  },
  {
    id: "completed",
    label: "清空已完成"
  }
];

export function createUploadCleanupActions({
  counts,
  onClear
}: {
  counts: Readonly<Record<UploadCleanupActionId, number>>;
  onClear: (action: UploadCleanupActionId) => void;
}): UploadCleanupAction[] {
  return uploadCleanupActionDefinitions.map((definition) => {
    const count = counts[definition.id];
    return {
      id: definition.id,
      label: definition.label,
      count,
      // 可见卡片归属是唯一的可用性来源。上传、草稿交接和其他队列动作
      // 只影响执行顺序，不得让同一按钮在任务生命周期中反复闪成 disabled。
      enabled: count > 0,
      confirmation: definition.confirmation,
      run: () => onClear(definition.id)
    };
  });
}
