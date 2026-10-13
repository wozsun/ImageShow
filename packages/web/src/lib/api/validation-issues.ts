import type { ApiValidationIssueDto } from "@imageshow/shared/browser";
import { isApiClientError } from "./client.js";

/** 请求校验失败（validation_error）时服务端给出的各字段问题；其他错误返回空数组。 */
export function apiValidationIssues(error: unknown): ApiValidationIssueDto[] {
  if (!isApiClientError(error) || error.code !== "validation_error") return [];
  const issues = (error.details as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter((issue): issue is ApiValidationIssueDto =>
    typeof issue?.field === "string" && typeof issue?.message === "string");
}
