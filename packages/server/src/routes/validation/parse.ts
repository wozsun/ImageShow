import type { z } from "zod";
import { ApiError } from "../../core/api-error.ts";
import { validationIssues } from "../../core/validation-issues.ts";

export function parse<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown
): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = validationIssues(result.error);
    const detail = [...new Set(issues.map((issue) => issue.message))].join("；") || "请求参数有误";
    throw new ApiError(400, "validation_error", detail, { issues });
  }
  return result.data;
}
