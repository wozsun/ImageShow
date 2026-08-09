import { useState } from "react";
import type {
  BatchImageUpdateRequestDto,
  BatchImageUpdateResponse
} from "@imageshow/shared/browser";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";
import { api } from "../../lib/api/client.js";
import { readEditableImageSnapshots } from "../../lib/api/image-edit.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import type { BatchEditableImageSnapshot } from "../../lib/types.js";
import { summarizeBatchUpdateFailures } from "./batch-update-failures.js";
import {
  createBatchMetadataSaveReport,
  type BatchMetadataSaveAttempt,
  type BatchMetadataSaveOutcome,
  type BatchMetadataSaveReport,
  type BatchMetadataUpdate
} from "./batch-metadata-session.js";

function reportBatchUpdateFailures(response: BatchImageUpdateResponse) {
  if (!response.failed) return;
  const summary = summarizeBatchUpdateFailures(response);
  reportAdminUiError(
    "image_metadata.batch_update_partial",
    new Error(`批量图片元数据更新失败 ${summary.failed}/${summary.requested}`),
    summary
  );
}

export function useBatchMetadataOperations({
  initialIds,
  onSaved
}: {
  initialIds: string[];
  onSaved: (
    authoritativeItems?: BatchEditableImageSnapshot[] | null
  ) => void | Promise<void>;
}) {
  const [pendingAttempt, setPendingAttempt] =
    useState<BatchMetadataSaveAttempt | null>(null);
  const [saveSummary, setSaveSummary] =
    useState<BatchMetadataSaveReport | null>(null);
  const saveStatus = useAsyncActionStatus({ successDurationMs: null });

  const readAuthoritativeSnapshot = async () => {
    try {
      const snapshot = await readEditableImageSnapshots(initialIds);
      return snapshot.items;
    } catch (error) {
      reportAdminUiError("image_metadata.batch_snapshot", error);
      return null;
    }
  };

  const finishAttempt = async (
    attempt: BatchMetadataSaveAttempt,
    notifySaved: boolean
  ): Promise<BatchMetadataSaveOutcome> => {
    const authoritativeItems = await readAuthoritativeSnapshot();
    const report = createBatchMetadataSaveReport(
      attempt,
      authoritativeItems
    );
    setSaveSummary(report);
    setPendingAttempt(authoritativeItems ? null : attempt);

    // mutation 每轮只触发一次集中图片查询失效。权威快照失败后的再次确认只重读
    // batch-snapshot，不重复 mutation，也不重复失效父级查询。
    if (notifySaved) {
      try {
        await onSaved(authoritativeItems);
      } catch (error) {
        reportAdminUiError("image_metadata.batch_update_refresh", error);
      }
    }
    return { attempt, authoritativeItems, report };
  };

  const save = async (
    items: BatchMetadataUpdate[],
    activeIds: string[]
  ): Promise<BatchMetadataSaveOutcome | null> => {
    if (!items.length && !pendingAttempt) return null;
    let outcome: BatchMetadataSaveOutcome | undefined;

    await saveStatus.run(async () => {
      const retryAttempt = pendingAttempt;
      let attempt = retryAttempt;
      if (!attempt) {
        setSaveSummary(null);
        let response: BatchImageUpdateResponse | null = null;
        try {
          const request = { items } satisfies BatchImageUpdateRequestDto;
          response = await api<BatchImageUpdateResponse>(
            `${adminApiBasePath}/images/batch-update`,
            { method: "POST", body: JSON.stringify(request) }
          );
          reportBatchUpdateFailures(response);
        } catch (error) {
          reportAdminUiError("image_metadata.batch_update", error);
        }
        attempt = {
          activeIds: [...activeIds],
          items,
          response
        };
      }

      outcome = await finishAttempt(attempt, !retryAttempt);
      return !outcome.report.snapshotFailed
        && outcome.report.failed === 0
        && outcome.report.unavailableIds.length === 0;
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
    saveSummary
  };
}
