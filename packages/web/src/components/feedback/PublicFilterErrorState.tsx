import { useEffect } from "react";
import { TagFilterError } from "@imageshow/shared/browser";
import { trackAnalytics } from "../../lib/analytics/analytics.js";
import { ErrorDetails } from "./ErrorDetails.js";
import {
  GallerySelectorError,
  gallerySelectorLabels,
  type GallerySelectorField
} from "../../lib/gallery/gallery-selectors.js";

export function PublicFilterErrorState({
  error,
  onClear,
  onRetry
}: {
  error: unknown;
  onClear: (field: GallerySelectorField | "tag") => void;
  onRetry: () => void;
}) {
  const tagError = error instanceof TagFilterError ? error : null;
  const selectorError = error instanceof GallerySelectorError ? error : null;
  const field = selectorError?.field ?? "tag";
  const label = selectorError ? gallerySelectorLabels[selectorError.field] : "标签";
  const code = selectorError ? "filter_selector" : tagError ? "filter_tag" : "filter_vocabulary";
  useEffect(() => {
    trackAnalytics({ event: "error_shown", status: null, code });
  }, [code, error]);
  return (
    <div className="query-error-state">
      <p role="alert">
        {selectorError
          ? selectorError.message
          : tagError
            ? `标签筛选错误：${tagError.message}`
            : "标签词表读取失败，请刷新后重试"}
      </p>
      {/* A filter the visitor can correct is not a fault; a failed vocabulary read is. */}
      {!selectorError && !tagError && <ErrorDetails error={error} />}
      {!selectorError && (!tagError || tagError.kind === "unknown") && (
        <button type="button" onClick={onRetry}>
          刷新标签并重试
        </button>
      )}
      <button type="button" onClick={() => onClear(field)}>
        清空{label}条件
      </button>
    </div>
  );
}
