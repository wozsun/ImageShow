import type { Brightness, Device, ImageDraft } from "./types.js";

export type CommonImageAttributes = {
  device: "" | Device | "auto";
  brightness: "" | Brightness | "auto";
  theme: string;
  author: string;
  tags: string[];
};

export function mergeCommonImageAttributes(
  draft: ImageDraft,
  common: CommonImageAttributes
): ImageDraft {
  return {
    ...draft,
    ...(common.device ? { device: common.device as ImageDraft["device"] } : {}),
    ...(common.brightness ? { brightness: common.brightness as ImageDraft["brightness"] } : {}),
    ...(common.theme.trim() ? { theme: common.theme } : {}),
    ...(common.author.trim() ? { author: common.author } : {}),
    ...(common.tags.length ? { tags: [...new Set([...draft.tags, ...common.tags])] } : {})
  };
}

export function normalizeTheme(value: string) {
  return value.trim().toLowerCase() || "none";
}

export function normalizeAuthor(value: string) {
  return value.trim().toLowerCase();
}
