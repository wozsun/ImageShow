import { z } from "zod";
import { imageVariants, parsePreparationProfile, type PreparationControl } from "@imageshow/shared/browser";

export const preparationControlInput = z.strictObject({
  action: z.enum(["start", "stop", "verify", "retry", "reconcile", "set-concurrency"]),
  revision: z.number().int().nonnegative(),
  concurrency: z.number().int().min(1).max(8).optional(),
  profile: z.unknown().transform((value, context) => {
    try { return parsePreparationProfile(value); }
    catch (error) {
      context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "参数无效" });
      return z.NEVER;
    }
  }).optional()
}) satisfies z.ZodType<PreparationControl>;
export const preparationPageInput = z.coerce.number().int().min(1).max(1_000_000);
export const preparationVariantInput = z.enum([...imageVariants, "original"]);
