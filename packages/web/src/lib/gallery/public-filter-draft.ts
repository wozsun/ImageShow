import {
  basicTagSelection,
  basicTagValue,
  TagFilterError,
  tagFilterValues,
  parseGalleryTagFilter,
  publicTagGroupLimit,
  type GalleryFacetsDto,
  type TagMatchMode
} from "@imageshow/shared/browser";
import {
  emptyGalleryFilters,
  galleryFiltersFromSearchParams,
  type GalleryFilters
} from "./gallery-query.js";
import { brightnessOptionLabel } from "../ui/select-options.js";
import { gallerySelectorValue, type GallerySelectorField } from "./gallery-selectors.js";

export const publicFilterSections = ["device", "brightness", "theme", "tag", "author"] as const;
export type PublicFilterSection = (typeof publicFilterSections)[number];
export const publicFilterLabels: Record<PublicFilterSection, string> = {
  device: "设备",
  brightness: "明暗",
  theme: "主题",
  tag: "标签",
  author: "作者"
};
export const publicFilterDeviceLabels: Record<string, string> = {
  auto: "自动判断",
  pc: "横版图片",
  mb: "竖版图片"
};
type SelectorDraft = { mode: "include" | "exclude"; selected: string[]; unresolved?: string[] };
type PublicTagGroup = { id: number; mode: TagMatchMode; selected: string[] };
export type TagSelection = { groups: PublicTagGroup[]; activeId: number; grouped: boolean };

export function createTagSelection(value: GalleryFilters["tag"] = ""): TagSelection {
  const values = tagFilterValues(value);
  parseGalleryTagFilter(values);
  const groups = values.length
    ? values.map((item, index) => ({ id: index + 1, ...basicTagSelection(item) }))
    : [{ id: 1, mode: "any" as const, selected: [] }];
  return { groups, activeId: groups.at(-1)!.id, grouped: groups.length > 1 };
}

function publicTagSlugs(selection: TagSelection) {
  return [...new Set(selection.groups.flatMap((group) => group.selected))];
}

function publicTagValue(selection: TagSelection): GalleryFilters["tag"] {
  if (selection.groups.length > publicTagGroupLimit) throw new Error("标签最多可分为 9 组");
  const values = selection.groups
    .filter((group) => group.selected.length)
    .map((group) => basicTagValue(group.selected, group.mode));
  parseGalleryTagFilter(values);
  return values.length > 1 ? values : (values[0] ?? "");
}

export type PublicFilterDraft = {
  device: string;
  brightness: string;
  theme: SelectorDraft;
  author: SelectorDraft;
  tag: { kind: "selection"; selection: TagSelection } | { kind: "unresolved"; values: string[] };
};

function selectorDraft(value: string): SelectorDraft {
  const values = value.split(",").filter(Boolean);
  return {
    mode: values.some((item) => item.startsWith("!")) ? "exclude" : "include",
    selected: values.map((item) => item.replace(/^!/, ""))
  };
}

export function createPublicFilterDraft(
  filters: GalleryFilters = emptyGalleryFilters,
  unresolvedTags: string[] = [],
  unresolvedSelectors: Partial<Record<GallerySelectorField, string[]>> = {}
): PublicFilterDraft {
  return {
    device: filters.device,
    brightness: filters.brightness,
    theme: { ...selectorDraft(filters.theme), unresolved: unresolvedSelectors.theme },
    author: { ...selectorDraft(filters.author), unresolved: unresolvedSelectors.author },
    tag: unresolvedTags.length
      ? { kind: "unresolved", values: [...unresolvedTags] }
      : { kind: "selection", selection: createTagSelection(filters.tag) }
  };
}

export function resolvePublicFilterTag(
  draft: PublicFilterDraft,
  facets: GalleryFacetsDto | undefined
) {
  let selection: TagSelection =
    draft.tag.kind === "selection" ? draft.tag.selection : createTagSelection();
  try {
    if (draft.tag.kind === "unresolved") {
      if (!facets) throw new Error("读取标签目录后才能确认原有标签条件");
      const params = new URLSearchParams();
      draft.tag.values.forEach((value) => params.append("tag", value));
      selection = createTagSelection(galleryFiltersFromSearchParams(params, facets.tags).tag);
    }
    const selected = publicTagSlugs(selection);
    if (selected.length) {
      if (!facets) throw new Error("标签目录暂不可用，请重试或清除标签条件");
      const known = new Set(facets.tags.map((tag) => tag.slug));
      const missing = selected.filter((slug) => !known.has(slug));
      if (missing.length)
        throw new Error(`标签已不在目录中：${missing.join("、")}。请重试或移除。`);
    }
    return { selection, error: null };
  } catch (error) {
    return { selection, error: error instanceof Error ? error.message : "标签条件无法识别" };
  }
}

export function publicDraftFilters(draft: PublicFilterDraft, tag: TagSelection): GalleryFilters {
  const selectorValue = (field: GallerySelectorField, selector: SelectorDraft) => {
    return gallerySelectorValue(
      field,
      selector.unresolved ??
        selector.selected.map((slug) => (selector.mode === "exclude" ? `!${slug}` : slug))
    );
  };
  return {
    device: draft.device,
    brightness: draft.brightness,
    theme: selectorValue("theme", draft.theme),
    author: selectorValue("author", draft.author),
    tag: publicTagValue(tag)
  };
}

/** Validate edited choices without blocking removal or unresolved URL recovery. */
export function validatePublicFilterEdit(
  next: PublicFilterDraft,
  previousTags: TagSelection
): void {
  const selection = next.tag.kind === "selection" ? next.tag.selection : previousTags;
  try {
    publicDraftFilters(
      {
        ...next,
        theme: { ...next.theme, unresolved: undefined },
        author: { ...next.author, unresolved: undefined }
      },
      selection
    );
  } catch (error) {
    // Removing a term can split identical groups and increase the normalized budget.
    // Accept removals; the complete draft remains invalid for statistics and applying.
    const onlyRemovesTags = selection.groups.every((group) => {
      const previous = previousTags.groups.find((item) => item.id === group.id);
      return (
        previous &&
        previous.mode === group.mode &&
        group.selected.every((slug) => previous.selected.includes(slug))
      );
    });
    if (!(error instanceof TagFilterError) || !onlyRemovesTags) throw error;
  }
}

export type PublicFilterChip = {
  section: PublicFilterSection;
  value: string;
  label: string;
  exclude: boolean;
  groupId?: number;
};
export function publicFilterChips(
  draft: PublicFilterDraft,
  tag: TagSelection,
  facets?: GalleryFacetsDto
): PublicFilterChip[] {
  const chips: PublicFilterChip[] = [];
  if (draft.device)
    chips.push({
      section: "device",
      value: draft.device,
      label: publicFilterDeviceLabels[draft.device] ?? draft.device,
      exclude: false
    });
  if (draft.brightness)
    chips.push({
      section: "brightness",
      value: draft.brightness,
      label: brightnessOptionLabel(draft.brightness),
      exclude: false
    });
  for (const [section, selected, options, exclude] of [
    ["theme", draft.theme.selected, facets?.themes, draft.theme.mode === "exclude"],
    ["tag", publicTagSlugs(tag), facets?.tags, false],
    ["author", draft.author.selected, facets?.authors, draft.author.mode === "exclude"]
  ] as const) {
    const names = new Map(
      options?.map((option) => [option.slug, option.display_name || option.slug])
    );
    for (const value of selected)
      chips.push({ section, value, label: names.get(value) ?? value, exclude });
  }
  return chips;
}

/** Group the selected-bar presentation without changing the distinct selection counts. */
export function groupPublicFilterChips(
  chips: PublicFilterChip[],
  tag: TagSelection
): PublicFilterChip[] {
  if (!tag.grouped) return chips;
  const names = new Map(
    chips.filter((chip) => chip.section === "tag").map((chip) => [chip.value, chip.label])
  );
  return publicFilterSections.flatMap((section): PublicFilterChip[] =>
    section === "tag"
      ? tag.groups
          .filter((group) => group.selected.length)
          .map((group) => ({
            section,
            groupId: group.id,
            value: basicTagValue(group.selected, group.mode),
            exclude: false,
            label: group.selected
              .map((slug) => names.get(slug) ?? slug)
              .join(group.mode === "all" ? " & " : " / ")
          }))
      : chips.filter((chip) => chip.section === section)
  );
}
