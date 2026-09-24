import { randomQueryLimits, slugMaxLength, slugPattern } from "@imageshow/shared/browser";

export type GallerySelectorField = "theme" | "author";
export const gallerySelectorLabels = { theme: "主题", author: "作者" } as const;

export class GallerySelectorError extends Error {
  constructor(readonly field: GallerySelectorField, message: string) {
    super(message);
    this.name = "GallerySelectorError";
  }
}

/** Share the public picker and route contract; never discard an invalid condition. */
export function gallerySelectorValue(field: GallerySelectorField, values: readonly string[]) {
  const label = gallerySelectorLabels[field];
  const tokens = [...new Set(values.flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase()))];
  if (tokens.length === 1 && tokens[0] === "") return "";
  for (const token of tokens) {
    const slug = token.startsWith("!") ? token.slice(1) : token;
    if (slug.length > slugMaxLength || !slugPattern.test(slug)) {
      throw new GallerySelectorError(field, `${label}条件格式无效`);
    }
  }
  if (tokens.some((value) => value.startsWith("!")) && tokens.some((value) => !value.startsWith("!"))) {
    throw new GallerySelectorError(field, `${label}不能同时使用包含和排除，请清除该条件后重新选择`);
  }
  if (tokens.length > randomQueryLimits.maxSelectorsPerField) {
    throw new GallerySelectorError(field, `${label}最多选择 ${randomQueryLimits.maxSelectorsPerField} 项`);
  }
  const value = tokens.sort().join(",");
  if (value.length > 1024) throw new GallerySelectorError(field, `${label}条件超过长度限制`);
  return value;
}
