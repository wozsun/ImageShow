import type { z } from "zod";
import type { ApiValidationIssueDto } from "@imageshow/shared/browser";

/**
 * 把 Zod 校验错误整理成 validation_error 的 details.issues：按字段完整路径去重，每个字段只取
 * 第一条问题，后台页面据此标出对应输入框。
 */
export function validationIssues(error: z.ZodError): ApiValidationIssueDto[] {
  const issues: ApiValidationIssueDto[] = [];
  for (const issue of error.issues) {
    const field = issue.path.map(String).join(".");
    if (!issues.some((item) => item.field === field)) {
      issues.push({ field, message: issue.message });
    }
  }
  return issues;
}
