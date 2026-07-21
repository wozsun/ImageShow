import { api } from "../api/client.js";
import { adminApiBasePath } from "../constants.js";

function boundedText(value: string, maximumLength: number) {
  return value.trim().slice(0, maximumLength);
}

function errorName(error: unknown) {
  if (error instanceof Error) return error.name;
  return typeof error;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message || "未提供错误消息";
  if (typeof error === "string") return error || "未提供错误消息";
  try {
    return JSON.stringify(error) || "未提供错误消息";
  } catch {
    return String(error) || "未提供错误消息";
  }
}

function errorDetails(error: unknown, metadata?: unknown) {
  if (!error || typeof error !== "object") return "";
  const record = error as Record<string, unknown>;
  const details = {
    ...(typeof record.status === "number" ? { status: record.status } : {}),
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.cause === "string" ? { cause: record.cause } : {}),
    ...(metadata === undefined ? {} : { metadata })
  };
  try {
    return Object.keys(details).length ? JSON.stringify(details) : "";
  } catch {
    return "";
  }
}

/**
 * 页面只展示可执行的短提示，原始异常则写入后台日志以便排查。
 * 日志接口不可用时仍保留控制台记录，且不会递归产生新的页面错误。
 */
export function reportAdminUiError(context: string, error: unknown, metadata?: unknown) {
  console.error(`[ImageShow] ${context}`, error);
  if (typeof window === "undefined") return;

  void api(`${adminApiBasePath}/logs/client-errors`, {
    method: "POST",
    body: JSON.stringify({
      context: boundedText(context, 120),
      name: boundedText(errorName(error), 120),
      message: boundedText(errorMessage(error), 2_000),
      stack: boundedText(error instanceof Error ? error.stack ?? "" : "", 8_000),
      details: boundedText(errorDetails(error, metadata), 2_000),
      page_path: boundedText(window.location.pathname, 500)
    })
  }).catch((reportingError) => {
    console.warn("页面错误日志上报失败", reportingError);
  });
}
