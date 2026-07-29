import { useMemo, useState } from "react";
import type {
  BatchImageSnapshotResponse,
  BatchImageUpdateItemInputDto,
  BatchImageUpdateRequestDto,
  BatchImageUpdateResponse
} from "@imageshow/shared/browser";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";
import { api } from "../../lib/api/client.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { summarizeBatchUpdateFailures } from "./batch-update-failures.js";

export type BatchMetadataUpdate = BatchImageUpdateItemInputDto;

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
  onSaved: () => void | Promise<void>;
}) {
  const [activeIds, setActiveIds] = useState(initialIds);
  const [availableIdSet, setAvailableIdSet] = useState<Set<string>>(
    () => new Set(initialIds)
  );
  const [savedIdSet, setSavedIdSet] = useState<Set<string>>(() => new Set());
  const [saveSummary, setSaveSummary] = useState<BatchImageUpdateResponse | null>(null);
  const saveStatus = useAsyncActionStatus({ successDurationMs: null });
  const activeIdSet = useMemo(() => new Set(activeIds), [activeIds]);
  const restorableRemovedCount = initialIds.filter(
    (id) => availableIdSet.has(id)
      && !activeIdSet.has(id)
      && !savedIdSet.has(id)
  ).length;

  const remove = (id: string) => {
    setActiveIds((current) => current.filter((candidate) => candidate !== id));
  };

  const readAuthoritativeSnapshot = async () => {
    try {
      return await api<BatchImageSnapshotResponse>(
        `${adminApiBasePath}/images/batch-snapshot`,
        {
          method: "POST",
          body: JSON.stringify({ ids: initialIds })
        }
      );
    } catch (error) {
      reportAdminUiError("image_metadata.batch_snapshot", error);
      return null;
    }
  };

  const save = async (
    items: BatchMetadataUpdate[],
    reconcileUncertainSave: () => Promise<void>
  ) => {
    if (!items.length) return false;
    setSaveSummary(null);

    return saveStatus.run(async () => {
      let response: BatchImageUpdateResponse | null = null;
      try {
        const request = { items } satisfies BatchImageUpdateRequestDto;
        response = await api<BatchImageUpdateResponse>(
          `${adminApiBasePath}/images/batch-update`,
          { method: "POST", body: JSON.stringify(request) }
        );
        setSaveSummary(response);
        const updatedIds = new Set(
          response.results
            .filter((result) => result.status === "updated")
            .map((result) => result.id)
        );
        if (updatedIds.size) {
          setSavedIdSet((current) => new Set([...current, ...updatedIds]));
          setActiveIds((current) => current.filter((id) => !updatedIds.has(id)));
        }
        reportBatchUpdateFailures(response);
      } catch (error) {
        reportAdminUiError("image_metadata.batch_update", error);
      }

      // A failed item or a lost response can still follow a committed metadata
      // or tag transaction. Re-read PostgreSQL truth before allowing the
      // frozen edit snapshot to be used as a restore baseline.
      if (!response || response.failed) {
        await reconcileUncertainSave();
      }
      try {
        await onSaved();
      } catch (error) {
        reportAdminUiError("image_metadata.batch_update_refresh", error);
      }
      return response?.failed === 0;
    });
  };

  const reconcileAvailableItems = (availableIds: string[]) => {
    const available = new Set(availableIds);
    setAvailableIdSet(available);
    setActiveIds((current) => current.filter((id) => available.has(id)));
  };

  const restoreActiveItems = (availableIds?: string[]) => {
    const available = availableIds
      ? new Set(availableIds)
      : availableIdSet;
    if (availableIds) setAvailableIdSet(available);
    setActiveIds(initialIds.filter(
      (id) => available.has(id) && !savedIdSet.has(id)
    ));
    setSaveSummary(null);
  };

  return {
    activeIds,
    activeIdSet,
    restorableRemovedCount,
    remove,
    readAuthoritativeSnapshot,
    reconcileAvailableItems,
    restoreActiveItems,
    save,
    saveStatus,
    saveSummary
  };
}
