import { useCallback, useMemo, useState } from "react";
import { adminApiBasePath } from "../../lib/constants.js";
import { api } from "../../lib/api/client.js";
import type { ImageItem } from "../../lib/types.js";
import {
  createActionFeedback,
  type ActionFeedbackState
} from "../../components/feedback/ActionFeedback.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { waitForMinimumPendingDuration } from "../../lib/ui/async-action-timing.js";

export type ImageAdminView = "ready" | "unset" | "deleted";

export type ImageAdminConfirmAction =
  | { kind: "batch-delete"; ids: string[] }
  | { kind: "empty-trash" }
  | { kind: "purge"; id: string; title: string };

const restoreChunkSize = 10;

export function imageAdminConfirmationCopy(
  action: ImageAdminConfirmAction | null
) {
  if (action?.kind === "batch-delete") {
    return {
      title: "确认批量删除",
      description: `将选中的 ${action.ids.length} 张图片移入回收站，可以稍后恢复。`,
      label: "确认删除"
    };
  }
  if (action?.kind === "empty-trash") {
    return {
      title: "确认清空回收站",
      description: "回收站内的所有图片及存储对象将被永久删除，此操作无法撤销。",
      label: "永久清空"
    };
  }
  if (action?.kind === "purge") {
    return {
      title: "确认永久删除",
      description: `“${action.title}”将从回收站和存储中永久删除，此操作无法撤销。`,
      label: "永久删除"
    };
  }
  return null;
}

export function useImageAdminOperations({
  items,
  invalidateData
}: {
  items: ImageItem[];
  invalidateData: () => Promise<unknown>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [operationText, setOperationText] = useState("");
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const [confirmAction, setConfirmAction] =
    useState<ImageAdminConfirmAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [busyIds, setBusyIds] = useState<string[]>([]);

  const operationBusy = actionBusy || busyIds.length > 0;
  const selectedItems = useMemo(
    () => items.filter((item) => selected.includes(item.id)),
    [items, selected]
  );
  const allSelected = items.length > 0 && selected.length === items.length;

  const showFeedback = useCallback((
    text: string,
    status: "error" | "success"
  ) => {
    setFeedback(createActionFeedback(text, status));
  }, []);

  const refresh = useCallback(async () => {
    setSelected([]);
    await invalidateData();
  }, [invalidateData]);

  const resetTransientState = useCallback(() => {
    setSelected([]);
    setFeedback(null);
  }, []);

  const runRowAction = useCallback(async (
    item: ImageItem,
    action: "delete" | "restore"
  ) => {
    if (operationBusy) return;
    setBusyIds([item.id]);
    setFeedback(null);
    setOperationText(action === "delete" ? "正在删除图片…" : "正在恢复图片…");
    const startedAt = Date.now();
    try {
      await api(`${adminApiBasePath}/images/${item.id}/${action}`, {
        method: "POST"
      });
      await refresh();
      await waitForMinimumPendingDuration(startedAt);
      showFeedback(
        action === "delete" ? "图片已移入回收站" : "图片已恢复",
        "success"
      );
    } catch (error) {
      reportAdminUiError(`image_admin.${action}`, error);
      await waitForMinimumPendingDuration(startedAt);
      showFeedback("图片操作失败，请稍后重试", "error");
    } finally {
      setOperationText("");
      setBusyIds([]);
    }
  }, [operationBusy, refresh, showFeedback]);

  const runConfirmedAction = useCallback(async () => {
    if (!confirmAction) return false;
    const affectedIds = confirmAction.kind === "batch-delete"
      ? confirmAction.ids
      : confirmAction.kind === "empty-trash"
        ? items.map((item) => item.id)
        : [confirmAction.id];
    setActionBusy(true);
    setBusyIds(affectedIds);
    setFeedback(null);
    setOperationText(
      confirmAction.kind === "batch-delete"
        ? `正在批量删除 ${confirmAction.ids.length} 张图片…`
        : confirmAction.kind === "empty-trash"
          ? "正在清空回收站…"
          : "正在永久删除图片…"
    );
    const startedAt = Date.now();
    try {
      let resultFeedback: {
        text: string;
        status: "error" | "success";
      };
      if (confirmAction.kind === "batch-delete") {
        const result = await api<{ deleted: number; ignored: number }>(
          `${adminApiBasePath}/images/batch-delete`,
          {
            method: "POST",
            body: JSON.stringify({ ids: confirmAction.ids })
          }
        );
        if (result.ignored) {
          reportAdminUiError(
            "image_admin.batch_delete_partial",
            new Error(`批量删除完成，但有 ${result.ignored} 张图片未处理`)
          );
        }
        resultFeedback = {
          text: `已删除 ${result.deleted} 张，${result.ignored} 张未处理`,
          status: result.ignored ? "error" : "success"
        };
      } else if (confirmAction.kind === "empty-trash") {
        const result = await api<{ deleted: number; failed: number }>(
          `${adminApiBasePath}/images/empty-trash`,
          { method: "POST" }
        );
        if (result.failed) {
          reportAdminUiError(
            "image_admin.empty_trash_partial",
            new Error(
              `清空回收站完成，但有 ${result.failed} 张图片的存储对象删除失败`
            )
          );
        }
        resultFeedback = {
          text: `已永久删除 ${result.deleted} 张${
            result.failed ? `，${result.failed} 张失败` : ""
          }`,
          status: result.failed ? "error" : "success"
        };
      } else {
        await api(
          `${adminApiBasePath}/images/${confirmAction.id}/purge`,
          { method: "POST" }
        );
        resultFeedback = {
          text: `已永久删除 ${confirmAction.title}`,
          status: "success"
        };
      }
      await refresh();
      await waitForMinimumPendingDuration(startedAt);
      showFeedback(resultFeedback.text, resultFeedback.status);
      return true;
    } catch (error) {
      reportAdminUiError("image_admin.confirmed_action", error);
      await waitForMinimumPendingDuration(startedAt);
      return false;
    } finally {
      setActionBusy(false);
      setOperationText("");
      setBusyIds([]);
    }
  }, [confirmAction, items, refresh, showFeedback]);

  const restoreSelected = useCallback(async () => {
    const ids = [...selected];
    const total = ids.length;
    if (!total) return;
    setActionBusy(true);
    setBusyIds(ids);
    setFeedback(null);
    setOperationText(`恢复中… 0 / ${total} 张`);
    const startedAt = Date.now();
    let restored = 0;
    let ignored = 0;
    try {
      for (let start = 0; start < total; start += restoreChunkSize) {
        const chunk = ids.slice(start, start + restoreChunkSize);
        const result = await api<{ restored: number; ignored: number }>(
          `${adminApiBasePath}/images/batch-restore`,
          { method: "POST", body: JSON.stringify({ ids: chunk }) }
        );
        restored += result.restored;
        ignored += result.ignored;
        setOperationText(
          `恢复中… ${Math.min(start + chunk.length, total)} / ${total} 张`
        );
      }
      await waitForMinimumPendingDuration(startedAt);
      showFeedback(
        `已恢复 ${restored} 张，${ignored} 张未处理`,
        ignored ? "error" : "success"
      );
      if (ignored) {
        reportAdminUiError(
          "image_admin.batch_restore_partial",
          new Error(`批量恢复完成，但有 ${ignored} 张图片未处理`)
        );
      }
    } catch (error) {
      reportAdminUiError("image_admin.batch_restore", error);
      await waitForMinimumPendingDuration(startedAt);
      showFeedback(`批量恢复中断，已恢复 ${restored} 张`, "error");
    } finally {
      await refresh().catch(() => undefined);
      setActionBusy(false);
      setOperationText("");
      setBusyIds([]);
    }
  }, [refresh, selected, showFeedback]);

  return {
    selected,
    setSelected,
    selectedItems,
    allSelected,
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
    runRowAction,
    runConfirmedAction,
    restoreSelected
  };
}
