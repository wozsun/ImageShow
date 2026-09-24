import { TagFilterError } from "@imageshow/shared/browser";
import { GallerySelectorError, gallerySelectorLabels, type GallerySelectorField } from "../../lib/gallery/gallery-selectors.js";

export function PublicFilterErrorState({ error, onClear, onRetry }: {
  error: unknown;
  onClear: (field: GallerySelectorField | "tag") => void;
  onRetry: () => void;
}) {
  const tagError = error instanceof TagFilterError ? error : null;
  const selectorError = error instanceof GallerySelectorError ? error : null;
  const field = selectorError?.field ?? "tag";
  const label = selectorError ? gallerySelectorLabels[selectorError.field] : "标签";
  return (
    <div className="query-error-state" role="alert">
      <p>{selectorError ? selectorError.message : tagError ? `标签筛选错误：${tagError.message}` : "标签词表读取失败，请刷新后重试"}</p>
      {!selectorError && (!tagError || tagError.kind === "unknown") && (
        <button type="button" onClick={onRetry}>刷新标签并重试</button>
      )}
      <button type="button" onClick={() => onClear(field)}>清空{label}条件</button>
    </div>
  );
}
