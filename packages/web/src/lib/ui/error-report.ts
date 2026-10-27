import { isApiClientError } from "../api/client.js";

/**
 * What an error page lets a visitor copy: the error and what this browser
 * knows about where it happened.
 */
export function errorReport(error: unknown) {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return [
    `时间：${new Date().toISOString()}`,
    `页面：${window.location.href}`,
    `运行方式：${window.parent === window ? "独立页面" : "iframe 嵌入"}`,
    `浏览器：${navigator.userAgent}`,
    `错误：${reason}`,
    ...(isApiClientError(error)
      ? [`HTTP 状态：${error.status}`, `错误码：${error.code || "未提供"}`]
      : []),
    ...(error instanceof Error && error.stack ? [`堆栈：\n${error.stack}`] : [])
  ].join("\n");
}
