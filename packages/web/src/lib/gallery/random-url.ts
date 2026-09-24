import {
  parseTagFilter,
  tagFilterValues,
  readableFilterSearch,
  tagExpressionValues,
  randomQueryLimits,
  TagFilterError,
  type RandomImageSize,
  type TagFilterValue
} from "@imageshow/shared/browser";
import type { RandomResponseMode } from "../types.js";

export function buildRandomUrl(input: {
  origin?: string;
  device: string;
  brightness: string;
  theme: string;
  tag: TagFilterValue;
  author: string;
  mode?: RandomResponseMode;
  size?: RandomImageSize;
}) {
  const params = new URLSearchParams();
  const tag = parseTagFilter(tagFilterValues(input.tag), "mixed");
  let submittedCount = tag.termCount;
  if (input.device) params.set("device", input.device);
  if (input.brightness !== "random") params.set("brightness", input.brightness);
  for (const field of ["theme", "author"] as const) {
    const submitted = input[field]
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (
      submitted.length > randomQueryLimits.maxSelectorsPerField ||
      submitted.some(
        (term) => [...term.replace(/^!/, "")].length > randomQueryLimits.maxSelectorCharacters
      )
    ) {
      throw new TagFilterError("随机链接的筛选词项超过数量或长度限制");
    }
    submittedCount += submitted.length;
    const values = [...new Set(submitted)].sort();
    if (values.length) params.set(field, values.join(","));
  }
  if (submittedCount > randomQueryLimits.maxSelectorCount)
    throw new TagFilterError("随机链接最多包含 64 个筛选词项");
  for (const value of tagExpressionValues(tag.expression)) params.append("tag", value);
  if (input.mode) params.set("mode", input.mode);
  if (input.size) params.set("size", input.size);
  const search = readableFilterSearch(params);
  if (new TextEncoder().encode(search).length > randomQueryLimits.maxRawBytes)
    throw new TagFilterError("随机链接超过长度限制");
  return `${input.origin ?? window.location.origin}/random${search ? `?${search}` : ""}`;
}

export function randomLinkResult(input: Parameters<typeof buildRandomUrl>[0]): {
  url: string | null;
  error: string | null;
} {
  try {
    return { url: buildRandomUrl(input), error: null };
  } catch (error) {
    if (!(error instanceof TagFilterError)) throw error;
    return { url: null, error: error.message };
  }
}
