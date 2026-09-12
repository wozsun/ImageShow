import { TagFilterError } from "@imageshow/shared/browser";
import { QueryErrorState } from "./QueryErrorState.js";

export function TagFilterErrorState({ error, onClear, onRetry }: {
  error: unknown;
  onClear: () => void;
  onRetry: () => void;
}) {
  if (!(error instanceof TagFilterError)) return <QueryErrorState error={error} onRetry={onRetry} />;
  return (
    <div className="query-error-state" role="alert">
      <p>标签筛选错误：{error.message}</p>
      {error.kind === "unknown" && (
        <button type="button" onClick={onRetry}>刷新标签并重试</button>
      )}
      <button type="button" onClick={onClear}>清空标签条件</button>
    </div>
  );
}
