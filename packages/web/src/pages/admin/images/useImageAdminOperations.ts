import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ImagePurgeRequestDto,
  ImagePurgeResponseDto,
  AdminImageListItemDto
} from "@imageshow/shared/browser";
import {
  moveImagesToTrash,
  purgeImages,
  restoreImages
} from "../../../lib/api/image-mutations.js";
import { readEditableImageSnapshots } from "../../../lib/api/image-edit.js";
import {
  createActionFeedback,
  type ActionFeedbackState
} from "../../../lib/ui/action-feedback.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import { waitForMinimumPendingDuration } from "../../../lib/ui/async-action-timing.js";
import { openTrashPurgeProgress } from "../../../lib/api/trash-purge-progress.js";
import { useTrashPurgeBackground } from "./useTrashPurgeBackground.js";

export type ImageAdminView = "ready" | "deleted";

export type ImageAdminConfirmAction = {
  kind: "purge";
  request: ImagePurgeRequestDto;
};

type ImageAdminAction = { kind: "trash"; ids: string[] } | ImageAdminConfirmAction;

export function imageAdminConfirmationCopy(action: ImageAdminConfirmAction | null) {
  if (action?.request.scope === "all") {
    return {
      title: "确认清空回收站",
      description:
        "将永久删除当前回收站快照中的全部图片。关闭页面或连接中断不会撤销已经提交的删除。之后才移入回收站的图片不受影响，此操作无法撤销。",
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

type ConfirmedMutationStatus = "error" | "success";

/**
 * Deletion progress inside the confirmation dialog, from server-pushed global
 * state. `total - pending` is the processed count, failures included.
 */
export type ConfirmedPurgeProgress = { total: number; pending: number };
type ConfirmedPurgeExit = "background" | "detached";
type ConfirmedMutationFeedbackTiming = "after-list-refresh" | "before-list-refresh";

function withIgnoredImageCount(text: string, ignored: number) {
  return ignored ? `${text}，${ignored} 张未处理` : text;
}

export async function settleConfirmedImageAdminMutation({
  startedAt,
  text,
  status,
  feedbackTiming,
  refresh,
  present
}: {
  startedAt: number;
  text: string;
  status: ConfirmedMutationStatus;
  feedbackTiming: ConfirmedMutationFeedbackTiming;
  refresh: () => Promise<unknown>;
  present: (
    text: string,
    status: ConfirmedMutationStatus
  ) => void;
}) {
  const presentBeforeRefresh = feedbackTiming === "before-list-refresh";
  if (presentBeforeRefresh) {
    await waitForMinimumPendingDuration(startedAt);
    // Trash and restore have no covering modal. Present their authoritative
    // result while the affected cards still occupy the current view, then
    // refresh list membership.
    present(text, status);
  }
  let refreshFailed = false;
  try {
    await refresh();
  } catch {
    refreshFailed = true;
  }
  if (!presentBeforeRefresh) {
    // Purge remains inside its confirmation dialog until this promise settles.
    // Start page feedback only when the dialog can close, so a slow refresh
    // cannot consume the feedback lifetime behind an inert page.
    await waitForMinimumPendingDuration(startedAt);
  }
  if (refreshFailed) {
    present(
      `${text}；图片列表刷新失败，请重新加载页面`,
      "error"
    );
  } else if (!presentBeforeRefresh) {
    present(text, status);
  }
}

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
  invalidateData,
  canPurge
}: {
  items: AdminImageListItemDto[];
  clearSelection: () => void;
  invalidateData: () => Promise<unknown>;
  canPurge: boolean;
}) {
  const [operationText, setOperationText] = useState("");
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const [confirmAction, setConfirmActionState] = useState<ImageAdminConfirmAction | null>(null);
  const [confirmError, setConfirmError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [confirmedPurgeProgress, setConfirmedPurgeProgress] =
    useState<ConfirmedPurgeProgress | null>(null);
  const exitConfirmedPurgeRef = useRef<((exit: ConfirmedPurgeExit) => void) | null>(null);

  const operationBusy = actionBusy || busyIds.length > 0;
  const setConfirmAction = useCallback((action: ImageAdminConfirmAction | null) => {
    setConfirmError("");
    setConfirmActionState(action);
  }, []);
  const showFeedback = useCallback((
    text: string,
    status: "error" | "success"
  ) => {
    setFeedback(createActionFeedback(text, status));
  }, []);
  const presentConfirmedMutation = useCallback(
    (
      text: string,
      status: ConfirmedMutationStatus
    ) => {
      setOperationText(text);
      showFeedback(text, status);
    },
    [showFeedback]
  );

  const refresh = useCallback(async () => {
    clearSelection();
    await invalidateData();
  }, [clearSelection, invalidateData]);

  const backgroundPurge = useTrashPurgeBackground({
    enabled: canPurge,
    onSettled: (final) => {
      // Both streams follow the same global state; a purge still followed in
      // its dialog settles this completion once, with its own result.
      if (exitConfirmedPurgeRef.current) return;
      void (async () => {
        let refreshFailed = false;
        try {
          // The user may be selecting elsewhere by now; purged cards leave the
          // selection together with the page items.
          await invalidateData();
        } catch {
          refreshFailed = true;
        }
        const text = !final
          ? "后台永久删除进度连接中断，请稍后刷新确认结果"
          : final.failed
            ? `后台永久删除已结束，回收站中有 ${final.failed} 张删除失败，将自动重试或需在检查页处理`
            : "后台永久删除已完成";
        showFeedback(
          refreshFailed ? `${text}；图片列表刷新失败，请重新加载页面` : text,
          !final || final.failed || refreshFailed ? "error" : "success"
        );
      })();
    }
  });

  // Follow a committed intent inside its confirmation dialog until no deletion
  // is pending, or until the user leaves the rest to the background.
  const followConfirmedPurge = useCallback(
    async (receipt: ImagePurgeResponseDto) => {
      const requested = receipt.queued + receipt.already_queued;
      if (!requested) return { final: { pending: 0, failed: 0 }, requested };
      let total = requested;
      let pending = requested;
      setConfirmedPurgeProgress({ total, pending });
      const exit = Promise.withResolvers<ConfirmedPurgeExit>();
      exitConfirmedPurgeRef.current = exit.resolve;
      const stream = openTrashPurgeProgress((progress) => {
        // Work joining the global queue while following (another purge or a
        // retry) extends the total, so the processed count never goes back.
        total += Math.max(0, progress.pending - pending);
        pending = progress.pending;
        setConfirmedPurgeProgress({ total, pending });
      });
      try {
        const outcome = await Promise.race([stream.done, exit.promise]);
        return typeof outcome === "string" ? outcome : { final: outcome, requested };
      } finally {
        stream.close();
        exitConfirmedPurgeRef.current = null;
        setConfirmedPurgeProgress(null);
      }
    },
    []
  );
  const moveConfirmedPurgeToBackground = useCallback(() => {
    exitConfirmedPurgeRef.current?.("background");
  }, []);
  // Leaving the page stops following; the committed intent continues server side.
  useEffect(() => () => exitConfirmedPurgeRef.current?.("detached"), []);

  const resetTransientState = useCallback(() => {
    setFeedback(null);
  }, []);

  const refreshUnknownOutcome = useCallback(
    async (
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
      } catch {
        // The list query owner records the read error. This operation owner only
        // classifies its user-visible outcome, avoiding a duplicate report.
        return { boundaryConfirmed, refreshSucceeded: false };
      }
    },
    [refresh]
  );

  const restore = useCallback(
    async (ids: string[]) => {
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
        await settleConfirmedImageAdminMutation({
          startedAt,
          text: withIgnoredImageCount(
            `已恢复 ${result.restored} 张`,
            result.ignored
          ),
          status: result.ignored ? "error" : "success",
          feedbackTiming: "before-list-refresh",
          refresh,
          present: presentConfirmedMutation
        });
      } finally {
        setActionBusy(false);
        setOperationText("");
        setBusyIds([]);
      }
    },
    [
      operationBusy,
      presentConfirmedMutation,
      refresh,
      refreshUnknownOutcome,
      showFeedback
    ]
  );

  const runAction = useCallback(
    async (action: ImageAdminAction) => {
      if (operationBusy) return false;
      const purgeRequest = action.kind === "purge"
        ? action.request
        : null;
      const affectedIds =
        action.kind === "trash"
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
            text = withIgnoredImageCount(
              `已移入回收站 ${result.trashed} 张`,
              result.ignored
            );
            status = result.ignored ? "error" : "success";
            if (result.ignored) {
              reportAdminUiError(
                "image_admin.trash_partial",
                new Error(`删除完成，但有 ${result.ignored} 张图片未处理`)
              );
            }
          } else {
            const receipt = await purgeImages(action.request);
            const followed = await followConfirmedPurge(receipt);
            if (followed === "detached") return false;
            if (followed === "background") {
              // The intent is committed; refresh so the cards show it, and let
              // the page subtitle follow the remaining deletions.
              setOperationText("");
              backgroundPurge.follow(true);
              try {
                await refresh();
              } catch {
                // The list query owner reports its read failure.
              }
              return true;
            }
            const { final, requested } = followed;
            // Only a completion this dialog actually followed covers the
            // background stream's; an empty receipt followed nothing.
            if (final && requested) backgroundPurge.acknowledgeCompletion();
            text = !final
              ? "永久删除已提交，但进度连接中断，请稍后刷新确认结果"
              : final.failed
                ? `永久删除已结束，回收站中有 ${final.failed} 张删除失败，将自动重试或需在检查页处理`
                : withIgnoredImageCount(`已永久删除 ${requested} 张`, receipt.ignored);
            status = !final || final.failed || receipt.ignored ? "error" : "success";
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
          const message = unknownOutcomeFeedback(reconciliation);
          if (action.kind === "purge") {
            // The confirmation dialog remains the visible interaction owner on
            // unknown purge outcomes. Keep the message there and disable a blind
            // mutation retry; page feedback would expire behind the inert layer.
            setConfirmError(message);
          } else {
            showFeedback(message, "error");
          }
          return false;
        }
        await settleConfirmedImageAdminMutation({
          startedAt,
          text,
          status,
          feedbackTiming: action.kind === "trash"
            ? "before-list-refresh"
            : "after-list-refresh",
          refresh,
          present: presentConfirmedMutation
        });
        return true;
      } finally {
        setActionBusy(false);
        setOperationText("");
        setBusyIds([]);
      }
    },
    [
      backgroundPurge.acknowledgeCompletion,
      backgroundPurge.follow,
      followConfirmedPurge,
      items,
      operationBusy,
      presentConfirmedMutation,
      refresh,
      refreshUnknownOutcome,
      showFeedback
    ]
  );

  const runConfirmedAction = useCallback(
    () => (confirmAction ? runAction(confirmAction) : Promise.resolve(false)),
    [confirmAction, runAction]
  );
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
    confirmError,
    setConfirmAction,
    actionBusy,
    busyIds,
    operationBusy,
    resetTransientState,
    runConfirmedAction,
    confirmedPurgeProgress,
    moveConfirmedPurgeToBackground,
    backgroundPurgeProgress: backgroundPurge.progress,
    trash,
    restore
  };
}
