import { useMemo, useState } from "react";
import type {
  BatchImageUpdateResponse,
  BatchStorageMigrationResponse
} from "@imageshow/shared/browser";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";
import { api } from "../../lib/api/client.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { shortImageId } from "../../lib/ui/formatters.js";

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

const failureSampleLimit = 5;
const failureCodeLimit = 20;
const failureSampleMessageLimit = 160;

/** @internal Exported for bounded-report behavior verification. */
export function summarizeBatchUpdateFailures(response: BatchImageUpdateResponse) {
  const failures = response.results.filter(
    (result): result is Extract<typeof result, { status: "failed" }> =>
      result.status === "failed"
  );
  const codeCounts = new Map<string, number>();
  for (const failure of failures) {
    const code = failure.code.trim().slice(0, 80) || "unknown";
    codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
  }

  return {
    requested: response.requested,
    failed: failures.length,
    codes: Object.fromEntries(
      [...codeCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, failureCodeLimit)
    ),
    samples: failures.slice(0, failureSampleLimit).map((failure) => ({
      image: shortImageId(failure.id),
      code: failure.code.trim().slice(0, 80),
      message: failure.message.trim().slice(0, failureSampleMessageLimit)
    }))
  };
}

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
  const [migrateError, setMigrateError] = useState("");
  const saveStatus = useAsyncActionStatus({ successDurationMs: null });
  const migrateStatus = useAsyncActionStatus({ successDurationMs: null });
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

  const migrate = async (target: string) => {
    setMigrateError("");
    return migrateStatus.run(async () => {
      try {
        const response = await api<BatchStorageMigrationResponse>(
          `${adminApiBasePath}/images/batch-migrate-storage`,
          {
            method: "POST",
            body: JSON.stringify({ ids: activeIds, target })
          }
        );
        if (response.migrated) onSaved();
        if (response.failed) {
          reportAdminUiError(
            "image_metadata.storage_migration_partial",
            new Error(`批量存储迁移失败 ${response.failed}/${activeIds.length}`),
            response
          );
          setMigrateError(
            `迁移未全部完成：成功 ${response.migrated} 项，失败 ${response.failed} 项。`
          );
          return false;
        }
        return true;
      } catch (error) {
        reportAdminUiError("image_metadata.storage_migration", error);
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
    saveSummary,
    migrate,
    migrateError,
    clearMigrateError: () => setMigrateError(""),
    migrateStatus
  };
}
