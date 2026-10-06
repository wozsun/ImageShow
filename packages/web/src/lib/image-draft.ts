import type { Brightness, Device, ImageDraft } from "./types.js";

export type ClearableImageAttribute = "tags" | "author" | "theme" | "all";

export type ImageAttributeClearPlan = Readonly<{
  count: number;
  maximumCount?: boolean;
  apply: () => Promise<void>;
  dispose?: () => void;
}>;

export type PrepareImageAttributeClear = (
  field: ClearableImageAttribute
) => ImageAttributeClearPlan | null;

export function imageAttributeClearPatch(field: ClearableImageAttribute): Partial<ImageDraft> {
  if (field === "all") return { tags: [], author: null, theme: null };
  if (field === "tags") return { tags: [] };
  if (field === "author") return { author: null };
  return { theme: null };
}

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

/** Theme or author draft value as saved: a lowercase slug, or null when empty. */
export function normalizeNamedSlug(value: string | null) {
  return value?.trim().toLowerCase() || null;
}
