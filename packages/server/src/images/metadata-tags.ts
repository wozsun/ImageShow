import { z } from "zod";
import {
  slugMaxLength,
  slugPattern
} from "@imageshow/shared/browser";

const imageTagSlugSchema = z.string().trim().toLowerCase()
  .min(1, "标识 slug 不能为空")
  .max(slugMaxLength, "标识 slug 最长 " + slugMaxLength + " 个字符")
  .regex(
    slugPattern,
    "标识 slug 只能包含小写字母、数字、连字符，且不能以连字符开头或结尾"
  );

type NormalizedImageTagSlugs = string[];

// The public limit applies after normalization, so repeated spellings do not
// consume the per-image tag allowance. HTTP requests and JSONL manifests share
// this image-metadata contract without either boundary owning the other.
export const normalizedImageTagSlugsSchema: z.ZodType<NormalizedImageTagSlugs> =
  z.array(imageTagSlugSchema)
    .transform((tags) => [...new Set(tags)])
    .pipe(z.array(imageTagSlugSchema).max(50));
