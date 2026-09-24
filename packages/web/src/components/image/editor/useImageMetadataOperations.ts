import { useState } from "react";
import type { ImageUpdateRequestDto, ImageUpdateResponseDto } from "@imageshow/shared/browser";
import { useAsyncActionStatus } from "../../../hooks/useAsyncActionStatus.js";
import { api } from "../../../lib/api/client.js";
import { requestWithDeadline } from "../../../lib/api/request-deadline.js";
import { readEditableImageSnapshots } from "../../../lib/api/image-edit.js";
import { adminApiBasePath } from "../../../lib/constants.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import { summarizeImageUpdateFailures } from "./image-update-failures.js";
import {
  createImageMetadataSaveReport,
  type ImageMetadataSaveAttempt,
  type ImageMetadataSaveOutcome,
  type ImageMetadataSaveReport,
  type ImageMetadataUpdate
} from "./image-metadata-session.js";
import type { ImageEditorSavedHandler, ImageMetadataSaveCommit } from "./image-editor-types.js";

function reportImageUpdateFailures(response: ImageUpdateResponseDto) {
  if (!response.failed) return;
  const summary = summarizeImageUpdateFailures(response);
  reportAdminUiError(
    "image_metadata.update_partial",
    new Error(`图片元数据更新失败 ${summary.failed}/${summary.requested}`),
    summary
  );
}

export function useImageMetadataOperations({
  initialIds,
  onSaved
}: {
  initialIds: string[];
  onSaved: ImageEditorSavedHandler;
}) {
  const [pendingAttempt, setPendingAttempt] = useState<ImageMetadataSaveAttempt | null>(null);
  const [lastSaveReport, setLastSaveReport] = useState<ImageMetadataSaveReport | null>(null);
  const saveStatus = useAsyncActionStatus({ resultDurationMs: null });

  const readAuthoritativeSnapshot = async () => {
    try {
      const snapshot = await readEditableImageSnapshots(initialIds);
      return snapshot.items;
    } catch (error) {
      reportAdminUiError("image_metadata.snapshot", error);
      return null;
    }
  };

  const publishSaved = async (commit: ImageMetadataSaveCommit) => {
    try {
      await onSaved(commit);
    } catch (error) {
      reportAdminUiError("image_metadata.update_refresh", error);
    }
  };

  const finishAttempt = async (
    attempt: ImageMetadataSaveAttempt,
    initialAttempt: boolean
  ): Promise<ImageMetadataSaveOutcome> => {
    const authoritativeItems = await readAuthoritativeSnapshot();
    const report = createImageMetadataSaveReport(attempt, authoritativeItems);
    setLastSaveReport(report);
    setPendingAttempt(authoritativeItems ? null : attempt);

    // 写响应未知时，首次保守刷新可能早于服务端提交；人工确认首次取得权威快照后，
    // 还需交接已确认结果。已有写响应的保存已在提交后刷新，不重复失效。
    if (initialAttempt || (attempt.response === null && authoritativeItems !== null)) {
      const updatedIds = new Set(
        report.results.flatMap((result) => (result.status === "updated" ? [result.id] : []))
      );
      // 没有写回执时，当前值不能证明 auto 等指令是否执行。仍按尝试字段刷新并
      // 交接权威当前值；保存状态和草稿继续独立保留未确认意图，不能重放写入。
      const committedUpdates =
        attempt.response === null
          ? attempt.items
          : attempt.items.filter((item) => updatedIds.has(item.id));
      // 立即交接权威数据；派生查询继续由父页面负责，不阻塞编辑器结束保存或关闭。
      void publishSaved({ authoritativeItems, updates: committedUpdates });
    }
    return { attempt, authoritativeItems, report };
  };

  const save = async (
    items: ImageMetadataUpdate[],
    activeIds: string[]
  ): Promise<ImageMetadataSaveOutcome | null> => {
    if (!items.length && !pendingAttempt) return null;
    let outcome: ImageMetadataSaveOutcome | undefined;

    await saveStatus.run(async () => {
      const retryAttempt = pendingAttempt;
      let attempt = retryAttempt;
      if (!attempt) {
        setLastSaveReport(null);
        const request = { items: structuredClone(items) } satisfies ImageUpdateRequestDto;
        attempt = { activeIds: [...activeIds], items: request.items, response: null };
        try {
          const body = JSON.stringify(request);
          const response = await requestWithDeadline((signal) =>
            api<ImageUpdateResponseDto>(`${adminApiBasePath}/images/update`, {
              method: "POST",
              body,
              signal
            })
          );
          attempt.response = response;
          reportImageUpdateFailures(response);
        } catch (error) {
          // 停止等待不能证明服务端未执行；只确认冻结的这一轮，不重放写入。
          reportAdminUiError("image_metadata.update", error);
        }
      }

      outcome = await finishAttempt(attempt, !retryAttempt);
      // A failed authoritative reread is a recoverable pending confirmation,
      // not a second failed save. The next click only rereads the snapshot.
      return (
        outcome.report.snapshotFailed ||
        (outcome.report.failed === 0 && outcome.report.unavailableIds.length === 0)
      );
    });
    return outcome ?? null;
  };

  const reconcilePendingSave = async () => {
    if (!pendingAttempt) return null;
    return finishAttempt(pendingAttempt, false);
  };

  return {
    pendingReconciliation: Boolean(pendingAttempt),
    reconcilePendingSave,
    save,
    saveStatus,
    lastSaveReport
  };
}
