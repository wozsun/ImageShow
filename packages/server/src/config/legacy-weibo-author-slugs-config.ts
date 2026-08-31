import { z } from "zod";
import {
  slugMaxLength,
  slugPattern
} from "@imageshow/shared/browser";

export type LegacyWeiboAuthorSlugs = Readonly<Record<string, string>>;

// Keep the retired field's exact 5.3.x contract pinned here. Config is
// infrastructure and must not depend back on the current authors domain.
const legacyWeiboUserId = z.string().regex(/^[1-9]\d{0,19}$/u);
const legacyAuthorSlug = z.string().trim().toLowerCase().min(1)
  .max(slugMaxLength).regex(slugPattern);
const legacyWeiboAuthorSlugs = z.preprocess((value, context) => {
  if (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.hasOwn(value, "__proto__")
  ) {
    context.addIssue({
      code: "custom",
      message: 'object key "__proto__" is not allowed',
      path: ["__proto__"]
    });
    return z.NEVER;
  }
  return value;
}, z.record(legacyWeiboUserId, legacyAuthorSlug));

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read only by the 5.4.0 startup upgrade before current-shape projection. */
export function legacyWeiboAuthorSlugsFromRuntimeConfig(
  value: unknown
): LegacyWeiboAuthorSlugs | undefined {
  if (!isPlainRecord(value) || !isPlainRecord(value.weibo)) return undefined;
  if (!Object.hasOwn(value.weibo, "author_slugs")) return undefined;
  const result = legacyWeiboAuthorSlugs.safeParse(value.weibo.author_slugs);
  if (!result.success) {
    throw new Error("Invalid legacy runtime config field weibo.author_slugs");
  }
  return Object.freeze(result.data);
}
