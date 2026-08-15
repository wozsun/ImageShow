import type { ImportJob } from "../../../lib/types.js";
import { importJobNeedsDuplicateConfirmation } from "./duplicate-match.js";
import { isUncommittedImportJob } from "./import-queue-state.js";

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
  matches: (job: ImportJob) => boolean;
  availableWhileBusy?: boolean;
  confirmation?: UploadCleanupConfirmation;
};

export function isCompletedImportJob(job: ImportJob) {
  return job.status === "done";
}

const uploadCleanupActionDefinitions: UploadCleanupActionDefinition[] = [
  {
    id: "duplicates",
    label: "清空重复待确认",
    matches: importJobNeedsDuplicateConfirmation
  },
  {
    id: "uncommitted",
    label: "清空未提交",
    matches: isUncommittedImportJob,
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
    label: "清空已完成",
    matches: isCompletedImportJob,
    availableWhileBusy: true
  }
];

export function createUploadCleanupActions({
  jobs,
  busy,
  onClear
}: {
  jobs: ImportJob[];
  busy: boolean;
  onClear: (predicate: (job: ImportJob) => boolean) => void;
}): UploadCleanupAction[] {
  return uploadCleanupActionDefinitions.map((definition) => {
    const count = jobs.filter(definition.matches).length;
    return {
      id: definition.id,
      label: definition.label,
      count,
      enabled: count > 0 && (!busy || definition.availableWhileBusy === true),
      confirmation: definition.confirmation,
      run: () => onClear(definition.matches)
    };
  });
}
