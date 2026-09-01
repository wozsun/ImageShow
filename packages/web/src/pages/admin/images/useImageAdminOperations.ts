import { useCallback, useState } from "react";
import type { ImagePurgeRequestDto } from "@imageshow/shared/browser";
import {
  moveImagesToTrash,
  purgeImages,
  restoreImages
} from "../../../lib/api/image-mutations.js";
import { readEditableImageSnapshots } from "../../../lib/api/image-edit.js";
import type { AdminImageListItem } from "../../../lib/types.js";
import {
  createActionFeedback,
  type ActionFeedbackState
} from "../../../lib/ui/action-feedback.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import { waitForMinimumPendingDuration } from "../../../lib/ui/async-action-timing.js";

export type ImageAdminView = "ready" | "unset" | "deleted";

export type ImageAdminConfirmAction = {
  kind: "purge";
  request: ImagePurgeRequestDto;
};

type ImageAdminAction =
  | { kind: "trash"; ids: string[] }
  | ImageAdminConfirmAction;

export function imageAdminConfirmationCopy(
  action: ImageAdminConfirmAction | null
) {
  if (action?.request.scope === "all") {
    return {
      title: "确认清空回收站",
      description: "将永久删除当前回收站快照中的全部图片。关闭页面或连接中断不会撤销已经提交的删除。之后才移入回收站的图片不受影响，此操作无法撤销。",
      label: "永久删除"
    };
  }
  if (action?.request.scope === "selected") {
    return {
      title: "确认删除已选图片",
      description: `将永久删除选中的 ${action.request.ids.length} 张图片。关闭页面或连接中断不会撤销已经提交的删除，此操作无法撤销。`,
      label: "永久删除"
    };
  }
  return null;
}

type UnknownOutcomeRefreshResult = {
  boundaryConfirmed: boolean;
  refreshSucceeded: boolean;
};

function unknownOutcomeFeedback(
  result: UnknownOutcomeRefreshResult,
  subject = "操作"
) {
  if (!result.refreshSucceeded) {
    return `${subject}结果未能确认，且图片列表刷新失败，请重新加载页面`;
  }
  return result.boundaryConfirmed
    ? `${subject}结果未能确认，图片列表已在操作收口后刷新`
    : `${subject}结果未能确认，图片列表已刷新，但无法确认操作已经收口，请稍后再次刷新`;
}

export function useImageAdminOperations({
  items,
  clearSelection,
  invalidateData
}: {
  items: AdminImageListItem[];
  clearSelection: () => void;
  invalidateData: () => Promise<unknown>;
}) {
  const [operationText, setOperationText] = useState("");
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const [confirmAction, setConfirmAction] =
    useState<ImageAdminConfirmAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [busyIds, setBusyIds] = useState<string[]>([]);

  const operationBusy = actionBusy || busyIds.length > 0;
  const showFeedback = useCallback((
    text: string,
    status: "error" | "success"
  ) => {
    setFeedback(createActionFeedback(text, status));
  }, []);

  const refresh = useCallback(async () => {
    clearSelection();
    await invalidateData();
  }, [clearSelection, invalidateData]);

  const resetTransientState = useCallback(() => {
    setFeedback(null);
  }, []);

  const refreshUnknownOutcome = useCallback(async (
    context: string,
    imageIds?: string[]
  ) => {
    let boundaryConfirmed = false;
    if (imageIds?.length) {
      try {
        await readEditableImageSnapshots(imageIds);
        boundaryConfirmed = true;
      } catch (error) {
        reportAdminUiError(`${context}_snapshot`, error);
      }
    }
    try {
      await refresh();
      return { boundaryConfirmed, refreshSucceeded: true };
    } catch (error) {
      reportAdminUiError(`${context}_refresh`, error);
      return { boundaryConfirmed, refreshSucceeded: false };
    }
  }, [refresh]);

  const restore = useCallback(async (ids: string[]) => {
    if (!ids.length || operationBusy) return;
    const single = ids.length === 1;
    setActionBusy(true);
    setBusyIds(ids);
    setFeedback(null);
    setOperationText(single ? "正在恢复图片…" : `正在恢复 ${ids.length} 张图片…`);
    const startedAt = Date.now();
    try {
      let result;
      try {
        result = await restoreImages(ids);
      } catch (error) {
        reportAdminUiError("image_admin.restore", error);
        const reconciliation = await refreshUnknownOutcome(
          "image_admin.restore",
          ids
        );
        await waitForMinimumPendingDuration(startedAt);
        showFeedback(
          unknownOutcomeFeedback(reconciliation, "恢复"),
          "error"
        );
        return;
      }
      if (result.ignored) {
        reportAdminUiError(
          "image_admin.restore_partial",
          new Error(`恢复完成，但有 ${result.ignored} 张图片未处理`)
        );
      }
      let refreshFailed = false;
      try {
        await refresh();
      } catch (error) {
        refreshFailed = true;
        reportAdminUiError("image_admin.restore_refresh", error);
      }
      await waitForMinimumPendingDuration(startedAt);
      showFeedback(
        `已恢复 ${result.restored} 张，${result.ignored} 张未处理${refreshFailed ? "；图片列表刷新失败，请重新加载页面" : ""
        }`,
        result.ignored || refreshFailed ? "error" : "success"
      );
    } finally {
      setActionBusy(false);
      setOperationText("");
      setBusyIds([]);
    }
  }, [operationBusy, refresh, refreshUnknownOutcome, showFeedback]);

  const runAction = useCallback(async (action: ImageAdminAction) => {
    if (operationBusy) return false;
    const purgeRequest = action.kind === "purge"
      ? action.request
      : null;
    const affectedIds = action.kind === "trash"
      ? action.ids
      : purgeRequest?.scope === "selected"
        ? purgeRequest.ids
        : items.map((item) => item.id);
    const single = affectedIds.length === 1;
    setActionBusy(true);
    setBusyIds(affectedIds);
    setFeedback(null);
    setOperationText(
      action.kind === "trash"
        ? single
          ? "正在删除图片…"
          : `正在删除 ${affectedIds.length} 张图片…`
        : purgeRequest?.scope === "all"
          ? "正在清空回收站…"
          : single
            ? "正在永久删除图片…"
            : `正在永久删除 ${affectedIds.length} 张图片…`
    );
    const startedAt = Date.now();
    try {
      let text: string;
      let status: "error" | "success";
      try {
        if (action.kind === "trash") {
          const result = await moveImagesToTrash(action.ids);
          text = `已移入回收站 ${result.trashed} 张，${result.ignored} 张未处理`;
          status = result.ignored ? "error" : "success";
          if (result.ignored) {
            reportAdminUiError(
              "image_admin.trash_partial",
              new Error(`删除完成，但有 ${result.ignored} 张图片未处理`)
            );
          }
        } else {
          const result = await purgeImages(action.request);
          text = result.remaining
            ? `已永久删除 ${result.deleted} 张，${result.remaining} 张仍由后台继续处理${result.ignored ? `，${result.ignored} 张未处理` : ""
            }`
            : `已永久删除 ${result.deleted} 张${result.ignored ? `，${result.ignored} 张未处理` : ""
            }`;
          status = result.remaining || result.ignored ? "error" : "success";
          if (status === "error") {
            reportAdminUiError(
              "image_admin.purge_partial",
              new Error(text)
            );
          }
        }
      } catch (error) {
        reportAdminUiError("image_admin.trash_or_purge", error);
        const reconciliation = await refreshUnknownOutcome(
          action.kind === "trash"
            ? "image_admin.trash"
            : "image_admin.purge",
          action.kind === "trash" ? action.ids : undefined
        );
        await waitForMinimumPendingDuration(startedAt);
        showFeedback(
          unknownOutcomeFeedback(reconciliation),
          "error"
        );
        return false;
      }
      let refreshFailed = false;
      try {
        await refresh();
      } catch (error) {
        refreshFailed = true;
        reportAdminUiError("image_admin.action_refresh", error);
      }
      await waitForMinimumPendingDuration(startedAt);
      showFeedback(
        `${text}${refreshFailed ? "；图片列表刷新失败，请重新加载页面" : ""}`,
        status === "error" || refreshFailed ? "error" : "success"
      );
      return true;
    } finally {
      setActionBusy(false);
      setOperationText("");
      setBusyIds([]);
    }
  }, [items, operationBusy, refresh, refreshUnknownOutcome, showFeedback]);

  const runConfirmedAction = useCallback(() => (
    confirmAction ? runAction(confirmAction) : Promise.resolve(false)
  ), [confirmAction, runAction]);
  const trash = useCallback(
    (ids: string[]) => runAction({ kind: "trash", ids }),
    [runAction]
  );
  return {
    operationText,
    feedback,
    setFeedback,
    showFeedback,
    confirmAction,
    setConfirmAction,
    actionBusy,
    busyIds,
    operationBusy,
    refresh,
    resetTransientState,
    runConfirmedAction,
    trash,
    restore
  };
}
