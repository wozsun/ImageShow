import { useEffect } from "react";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { Icon } from "../icon/Icon.js";
import { ErrorDetails } from "./ErrorDetails.js";

export function QueryErrorState({
  error,
  onRetry,
  fullPage = false,
  details = true,
  reportContext
}: {
  error: unknown;
  onRetry: () => void;
  fullPage?: boolean;
  /** A compact notice over content that stays usable leaves the report out. */
  details?: boolean;
  reportContext?: string;
}) {
  useEffect(() => {
    if (reportContext) reportAdminUiError(reportContext, error);
  }, [error, reportContext]);

  return (
    <div className={`${fullPage ? "center " : ""}query-error-state`}>
      {/* Only the notice is announced, not the copyable report below it. */}
      <p role="alert">加载失败，请稍后重试</p>
      {details && <ErrorDetails error={error} />}
      <button type="button" onClick={onRetry}>
        <Icon name="refresh-line" />
        重试
      </button>
    </div>
  );
}
