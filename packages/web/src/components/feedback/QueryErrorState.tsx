import { useEffect } from "react";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { Icon } from "../icon/Icon.js";

export function QueryErrorState({ error, onRetry, fullPage = false, reportContext }: {
  error: unknown;
  onRetry: () => void;
  fullPage?: boolean;
  reportContext?: string;
}) {
  useEffect(() => {
    if (reportContext) reportAdminUiError(reportContext, error);
  }, [error, reportContext]);

  return (
    <div className={`${fullPage ? "center " : ""}query-error-state`} role="alert">
      <p>加载失败，请稍后重试</p>
      <button type="button" onClick={onRetry}><Icon name="refresh-line" />重试</button>
    </div>
  );
}
