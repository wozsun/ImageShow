import { shortImageId } from "../../../lib/ui/formatters.js";
import type { BatchMetadataSaveReport } from "./batch-metadata-session.js";

export function BatchMetadataSaveSummary({ summary }: {
  summary: BatchMetadataSaveReport;
}) {
  const pending = summary.snapshotFailed
    ? summary.responseReceived ? summary.updated : summary.results.length
    : 0;
  const updated = summary.snapshotFailed ? 0 : summary.updated;
  const failed = summary.snapshotFailed && !summary.responseReceived
    ? 0
    : summary.failed;
  return (
    <div className="notice-line batch-edit-save-summary" role="status">
      {summary.snapshotFailed ? (
        <>保存请求已结束：待确认 {pending} 项，失败 {failed} 项。</>
      ) : (
        <>保存完成：成功 {updated} 项，失败 {failed} 项。</>
      )}
      {summary.snapshotFailed && (
        <div className="batch-edit-confirmation-pending">
          服务暂不可用，权威结果待确认；草稿已保留，再次点击只会重试确认，不会重复提交。
        </div>
      )}
      {summary.unavailableIds.length > 0 && (
        <div className="admin-error">
          {summary.unavailableIds.length} 项已不存在或不可编辑，已从当前会话移除。
        </div>
      )}
      {summary.results
        .filter((result) => (
          result.status === "failed"
          && (!summary.snapshotFailed || summary.responseReceived)
        ))
        .map((result) => (
          <div className="admin-error" key={result.id}>
            {shortImageId(result.id)}：保存失败
          </div>
        ))}
    </div>
  );
}
