import { z } from "zod";
import {
  vocabularyDisplayNameMaxLength
} from "@imageshow/shared/browser";
import {
  httpsUrlField,
  requestSlugInput
} from "./primitives.ts";

const displayNameInput = z.string().trim().max(
  vocabularyDisplayNameMaxLength,
  "显示名最长 " + vocabularyDisplayNameMaxLength + " 个字符"
);

export const tagSlugInput = requestSlugInput;
export const tagCreateInput = z.strictObject({
  slug: tagSlugInput,
  display_name: displayNameInput.optional().default("")
});
export const tagDisplayUpdateInput = z.strictObject({
  display_name: displayNameInput
});

export const themeSlugInput = requestSlugInput;
export const themeCreateInput = z.strictObject({
  slug: themeSlugInput,
  display_name: displayNameInput.optional().default("")
});
export const themeDisplayUpdateInput = z.strictObject({
  display_name: displayNameInput
});

export const authorSlugInput = requestSlugInput;
const authorLinkInput = httpsUrlField(
  "作者主页链接需为有效的 HTTPS 链接"
);
export const authorCreateInput = z.strictObject({
  slug: authorSlugInput,
  display_name: displayNameInput.optional().default(""),
  link: authorLinkInput
});
export const authorMetaUpdateInput = z.strictObject({
  display_name: displayNameInput,
  link: authorLinkInput
});

export const vocabularySlugListInput = z.strictObject({
  slugs: z.array(requestSlugInput).min(1).max(2000)
    .transform((slugs) => [...new Set(slugs)])
});
