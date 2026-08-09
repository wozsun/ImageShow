import { shortImageId } from "../../lib/ui/formatters.js";
import type { BatchMetadataSaveReport } from "./batch-metadata-session.js";

export function BatchMetadataSaveSummary({ summary }: {
  summary: BatchMetadataSaveReport;
}) {
  return (
    <div className="notice-line batch-edit-save-summary" role="status">
      保存完成：成功 {summary.updated} 项，失败 {summary.failed} 项。
      {summary.snapshotFailed && (
        <div className="error">
          权威数据回读失败，草稿已保留；再次保存只会重试确认，不会重复提交。
        </div>
      )}
      {summary.unavailableIds.length > 0 && (
        <div className="error">
          {summary.unavailableIds.length} 项已不存在或不可编辑，已从当前会话移除。
        </div>
      )}
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
