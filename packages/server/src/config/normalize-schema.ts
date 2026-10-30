import { z } from "zod";
import {
  imageVariants,
  runtimeConfigLimits,
  variantSettingLimits,
  type ImageVariant
} from "@imageshow/shared/browser";

function variantSchema(variant: ImageVariant) {
  const limits = variantSettingLimits[variant];
  return z.strictObject({
    quality: z.number().int().min(limits.quality[0]).max(limits.quality[1]),
    min_quality: z.number().int().min(limits.min_quality[0]).max(limits.min_quality[1]),
    max_long_edge: z.number().int().min(limits.max_long_edge[0]).max(limits.max_long_edge[1]),
    max_size_kb: z.number().int().min(limits.max_size_kb[0]).max(limits.max_size_kb[1])
  });
}

const shape = {
  concurrency: z
    .number()
    .int()
    .min(runtimeConfigLimits["normalize.concurrency"].min)
    .max(runtimeConfigLimits["normalize.concurrency"].max),
  quality_step: z
    .number()
    .int()
    .min(runtimeConfigLimits["normalize.quality_step"].min)
    .max(runtimeConfigLimits["normalize.quality_step"].max),
  large: variantSchema("large"),
  medium: variantSchema("medium"),
  small: variantSchema("small")
};

export const normalizeSchema = z.strictObject(shape).superRefine((profile, context) => {
  for (const variant of imageVariants) {
    if (profile[variant].min_quality > profile[variant].quality) {
      context.addIssue({
        code: "custom",
        path: [variant, "min_quality"],
        message: "最低质量不能超过初始质量"
      });
    }
  }
  for (const key of ["max_long_edge", "max_size_kb"] as const) {
    if (profile.small[key] > profile.medium[key] || profile.medium[key] > profile.large[key]) {
      context.addIssue({
        code: "custom",
        path: ["medium", key],
        message: "必须满足小图 ≤ 中图 ≤ 大图"
      });
    }
  }
});
