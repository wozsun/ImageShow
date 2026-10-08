import { z } from "zod";
import { sortOrderUpdateInput } from "./sort-order.ts";
import {
  vocabularyDisplayNameMaxLength,
  unsetSelector
} from "@imageshow/shared/browser";
import {
  httpsUrlField,
  requestSlugInput
} from "./primitives.ts";

const displayNameInput = z
  .string()
  .trim()
  .max(vocabularyDisplayNameMaxLength, "显示名最长 " + vocabularyDisplayNameMaxLength + " 个字符");

export const tagSlugInput = requestSlugInput;
export const tagCreateInput = z.strictObject({
  slug: tagSlugInput,
  display_name: displayNameInput.optional().default(""),
  sort_order: sortOrderUpdateInput.shape.sort_order.optional()
});
export const tagDisplayUpdateInput = z.strictObject({
  display_name: displayNameInput
});

function namedVocabularySlugInput(noun: string) {
  return requestSlugInput.refine(
    (value) => value !== unsetSelector,
    `null 是未设置${noun}的保留值，不能用作${noun}标识`
  );
}

export const themeSlugInput = namedVocabularySlugInput("主题");
export const themeCreateInput = z.strictObject({
  slug: themeSlugInput,
  display_name: displayNameInput.optional().default(""),
  sort_order: sortOrderUpdateInput.shape.sort_order.optional()
});
export const themeDisplayUpdateInput = z.strictObject({
  display_name: displayNameInput
});

export const authorSlugInput = namedVocabularySlugInput("作者");
const authorLinkInput = httpsUrlField("作者主页链接需为有效的 HTTPS 链接");
export const authorCreateInput = z.strictObject({
  slug: authorSlugInput,
  display_name: displayNameInput.optional().default(""),
  sort_order: sortOrderUpdateInput.shape.sort_order.optional(),
  link: authorLinkInput
});
export const authorMetaUpdateInput = z.strictObject({
  display_name: displayNameInput,
  link: authorLinkInput
});
