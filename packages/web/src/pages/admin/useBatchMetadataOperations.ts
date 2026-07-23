import { useMemo, useState } from "react";
import type { BatchImageUpdateResponse } from "@imageshow/shared/browser";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";
import { api } from "../../lib/api/client.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { summarizeBatchUpdateFailures } from "./batch-update-failures.js";

export type BatchMetadataUpdate = {
  id: string;
  title?: string;
  description?: string;
  source?: string;
  original?: string;
  device?: "pc" | "mb" | "auto";
  brightness?: "dark" | "light" | "auto";
  theme?: string;
  author?: string;
  tags?: string[];
};

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
  onSaved: () => void;
}) {
  const [activeIds, setActiveIds] = useState(initialIds);
  const [saveSummary, setSaveSummary] = useState<BatchImageUpdateResponse | null>(null);
  const saveStatus = useAsyncActionStatus({ successDurationMs: null });
  const activeIdSet = useMemo(() => new Set(activeIds), [activeIds]);

  const remove = (id: string) => {
    setActiveIds((current) => current.filter((candidate) => candidate !== id));
  };

  const save = async (items: BatchMetadataUpdate[]) => {
    if (!items.length) return false;
    setSaveSummary(null);

    return saveStatus.run(async () => {
      try {
        const response = await api<BatchImageUpdateResponse>(
          `${adminApiBasePath}/images/batch-update`,
          { method: "POST", body: JSON.stringify({ items }) }
        );
        setSaveSummary(response);
        const updatedIds = new Set(
          response.results
            .filter((result) => result.status === "updated")
            .map((result) => result.id)
        );
        if (updatedIds.size) {
          setActiveIds((current) => current.filter((id) => !updatedIds.has(id)));
          onSaved();
        }
        reportBatchUpdateFailures(response);
        return response.failed === 0;
      } catch (error) {
        reportAdminUiError("image_metadata.batch_update", error);
        return false;
      }
    });
  };

  return {
    activeIds,
    activeIdSet,
    remove,
    save,
    saveStatus,
    saveSummary
  };
}
