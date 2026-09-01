import { z } from "zod";
import {
  slugMaxLength,
  slugPattern
} from "@imageshow/shared/browser";
import { isHttpsUrl } from "../../core/url-validation.ts";
import {
  normalizedUuidSchema,
  normalizedUuidV7Schema
} from "../../core/uuid.ts";

export const uuidInput = normalizedUuidSchema;
export const uuidV7Input = normalizedUuidV7Schema;

export const requestSlugInput = z.string().trim().toLowerCase()
  .min(1, "标识 slug 不能为空")
  .max(slugMaxLength, "标识 slug 最长 " + slugMaxLength + " 个字符")
  .regex(
    slugPattern,
    "标识 slug 只能包含小写字母、数字、连字符，且不能以连字符开头或结尾"
  );

export const safePositiveIntegerInput = z.coerce.number().int().positive()
  .refine(Number.isSafeInteger, "必须是安全整数");

export function requestUrlInput(message: string) {
  return z.string().trim().max(2048)
    .transform((value) => {
      if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
      return "https://" + value;
    })
    .refine((value) => value === "" || isHttpsUrl(value), message);
}

export function httpsUrlField(message: string) {
  return requestUrlInput(message).default("");
}

export function optionalHttpsDomainUrlField(message: string) {
  return requestUrlInput(message).optional()
    .refine(
      (value) => !value || isHttpsUrl(value, { requireDomain: true }),
      message
    );
}

export function addDuplicateValueIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  issuePath: (index: number) => PropertyKey[],
  message: string
) {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (seen.has(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: issuePath(index),
        message
      });
    }
    seen.add(value);
  }
}
