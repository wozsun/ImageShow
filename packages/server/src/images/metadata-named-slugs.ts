import { z } from "zod";
import { slugMaxLength, slugPattern, unsetSelector } from "@imageshow/shared/browser";

/** Theme and author share one shape: a named slug, or JSON null for none. */
function namedSlugInput(noun: string) {
  return z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(slugMaxLength)
    .regex(slugPattern)
    .refine((value) => value !== unsetSelector, `null 是未设置${noun}的保留值，请使用 JSON null`)
    .nullable();
}

export const imageThemeInput = namedSlugInput("主题");
export const imageAuthorInput = namedSlugInput("作者");
