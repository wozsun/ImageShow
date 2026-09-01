import type { z } from "zod";
import { ApiError } from "../../core/api-error.ts";

export function parse<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown
): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const flat = result.error.flatten();
    const messages = [
      ...flat.formErrors,
      ...Object.values(flat.fieldErrors).flatMap((errors) => errors ?? [])
    ];
    const detail = [...new Set(messages)].join("；") || "请求参数有误";
    throw new ApiError(400, "validation_error", detail, flat);
  }
  return result.data;
}
