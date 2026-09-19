import { safeLogText, safeLogValue } from "@imageshow/shared/browser";
import { api } from "../api/client.js";
import { adminApiBasePath } from "../constants.js";

/** Browser diagnostics and server reports share the same bounded, scrubbed data. */
export function reportAdminUiError(context: string, error: unknown, metadata?: unknown) {
  const report = {
    context: safeLogText(context, 100),
    error: safeLogValue(error),
    ...(metadata === undefined ? {} : { metadata: safeLogValue(metadata) })
  };
  console.error("[ImageShow]", report);
  if (typeof window === "undefined") return;

  void api(`${adminApiBasePath}/logs/client-errors`, {
    method: "POST",
    body: JSON.stringify(report)
  }).catch((reportingError) => {
    console.warn("页面错误日志上报失败", safeLogValue(reportingError));
  });
}
