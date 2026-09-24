import { z } from "zod";
import { isThemeSlug, slugMaxLength, slugPattern } from "@imageshow/shared/browser";

export const imageThemeInput = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(slugMaxLength)
  .regex(slugPattern)
  .refine(isThemeSlug, "null 是未设置主题的保留值，请使用 JSON null")
  .nullable();
