import { TagFilterError } from "@imageshow/shared/browser";

export function TagFilterErrorState({ error, onClear, onRetry }: {
  error: unknown;
  onClear: () => void;
  onRetry: () => void;
}) {
  const tagError = error instanceof TagFilterError ? error : null;
  return (
    <div className="query-error-state" role="alert">
      <p>{tagError ? `标签筛选错误：${tagError.message}` : "标签词表读取失败，请刷新后重试"}</p>
      {(!tagError || tagError.kind === "unknown") && (
        <button type="button" onClick={onRetry}>刷新标签并重试</button>
      )}
      <button type="button" onClick={onClear}>清空标签条件</button>
    </div>
  );
}
