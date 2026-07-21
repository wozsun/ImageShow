import type { BatchImageUpdateResponse } from "@imageshow/shared/browser";
import { shortImageId } from "../../lib/ui/formatters.js";

export function BatchMetadataSaveSummary({ summary }: {
  summary: BatchImageUpdateResponse;
}) {
  return (
    <div className="notice-line batch-edit-save-summary" role="status">
      保存完成：成功 {summary.updated} 项，失败 {summary.failed} 项。
      {summary.results
        .filter((result) => result.status === "failed")
        .map((result) => (
          <div className="error" key={result.id}>
            {shortImageId(result.id)}：保存失败
          </div>
        ))}
    </div>
  );
}
