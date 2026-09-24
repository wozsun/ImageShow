import {
  parseTagFilter,
  parseGalleryTagFilter,
  tagFilterValues,
  basicTagValue,
  resolveTagExpression,
  tagExpressionValues,
  readableFilterSearch,
  detectDeviceFromUserAgent,
  showModes,
  publicImageOrders,
  TagFilterError,
  type ShowMode,
  type ShowOrder,
  type PublicImageView,
  type TagFilterValue
} from "@imageshow/shared/browser";
import { GallerySelectorError, gallerySelectorValue, type GallerySelectorField } from "./gallery-selectors.js";

export type GalleryFilters = {
  device: string;
  brightness: string;
  theme: string;
  tag: TagFilterValue;
  author: string;
};

const galleryDevices = new Set(["pc", "mb", "auto"]);
const galleryBrightnesses = new Set(["dark", "light"]);
const showOrderSet = new Set<ShowOrder>(publicImageOrders);
const showModeSet = new Set<ShowMode>(showModes);

export const emptyGalleryFilters: GalleryFilters = {
  device: "",
  brightness: "",
  theme: "",
  tag: "",
  author: ""
};

function galleryTagValue(
  values: string[],
  tags?: readonly { slug: string; display_name: string }[]
) {
  parseGalleryTagFilter(values);
  const map = tags ? new Map(tags.map((tag) => [tag.display_name.trim().toLowerCase(), tag.slug])) : null;
  for (const tag of tags ?? []) map!.set(tag.slug, tag.slug);
  const normalizedTags = values.map((value) => {
    const parsed = parseTagFilter([value]);
    const expression = map ? resolveTagExpression(parsed.expression, map) : parsed.expression;
    return basicTagValue(expression?.anyOf.flat() ?? [], parsed.mode);
  });
  parseGalleryTagFilter(normalizedTags);
  return normalizedTags.length > 1 ? normalizedTags : normalizedTags[0] ?? "";
}

/** Keep field errors separate so repairing one cannot silently remove another. */
export function readGalleryFilters(
  params: URLSearchParams,
  tags?: readonly { slug: string; display_name: string }[]
) {
  const device = params.get("device")?.trim().toLowerCase() ?? "";
  const brightness = params.get("brightness")?.trim().toLowerCase() ?? "";
  const filters: GalleryFilters = {
    device: device === "all" ? "" : galleryDevices.has(device) ? device : "",
    brightness: galleryBrightnesses.has(brightness) ? brightness : "",
    theme: "", tag: "", author: ""
  };
  const errors: (GallerySelectorError | TagFilterError)[] = [];
  const unresolvedSelectors: Partial<Record<GallerySelectorField, string[]>> = {};
  for (const field of ["theme", "author"] as const) {
    try { filters[field] = gallerySelectorValue(field, params.getAll(field)); }
    catch (error) {
      if (!(error instanceof GallerySelectorError)) throw error;
      errors.push(error);
      unresolvedSelectors[field] = params.getAll(field);
    }
  }
  try { filters.tag = galleryTagValue(params.getAll("tag"), tags); }
  catch (error) {
    if (!(error instanceof TagFilterError)) throw error;
    errors.push(error);
  }
  return { filters, error: errors[0] ?? null, unresolvedSelectors };
}

export function galleryFiltersFromSearchParams(
  params: URLSearchParams,
  tags?: readonly { slug: string; display_name: string }[]
): GalleryFilters {
  const result = readGalleryFilters(params, tags);
  if (result.error) throw result.error;
  return result.filters;
}

export function galleryRouteSearchParams(filters: GalleryFilters, preserveTagMode = true) {
  const params = new URLSearchParams();
  if (galleryDevices.has(filters.device)) params.set("device", filters.device);
  if (filters.brightness) params.set("brightness", filters.brightness);
  if (filters.theme) params.set("theme", filters.theme);
  if (filters.tag) {
    const values = tagFilterValues(filters.tag);
    const parsed = parseGalleryTagFilter(values);
    for (const value of preserveTagMode ? values : tagExpressionValues(parsed.expression)) params.append("tag", value);
  }
  if (filters.author) params.set("author", filters.author);
  return params;
}

/** List and statistics share the same resolved devices and canonical filter sets. */
function galleryApiFilters(filters: GalleryFilters, userAgent: string, preserveTagMode = false) {
  const params = galleryRouteSearchParams({
    ...filters,
    device: filters.device === "auto" ? detectDeviceFromUserAgent(userAgent) ?? "" : filters.device
  }, preserveTagMode);
  for (const field of ["theme", "author"] as const) {
    const value = gallerySelectorValue(field, params.getAll(field));
    if (value) params.set(field, value);
    else params.delete(field);
  }
  return params;
}

/** Statistics retain group boundaries; a selected AND group narrows tag candidates. */
export function galleryStatsSearch(filters: GalleryFilters, userAgent = "", tagScope?: number | null) {
  const params = galleryApiFilters(filters, userAgent, true);
  const groups = params.getAll("tag");
  const scope = tagScope === undefined && groups.length === 1 && parseTagFilter(groups).mode === "all"
    ? 1 : tagScope;
  if (scope != null) params.set("tag_scope", String(scope));
  return readableFilterSearch(params);
}

export function showOrderFromSearchParams(
  params: URLSearchParams,
  fallback: ShowOrder
) {
  const value = params.get("order")?.trim().toLowerCase() as ShowOrder;
  return showOrderSet.has(value) ? value : fallback;
}

export function showModeFromSearchParams(
  params: URLSearchParams,
  fallback: ShowMode
) {
  const value = params.get("mode")?.trim().toLowerCase() as ShowMode;
  return showModeSet.has(value) ? value : fallback;
}

/** Patch user choices without materializing defaults from the resolved view. */
export function updateImageBrowseSearchParams(
  current: URLSearchParams,
  changes: Partial<GalleryFilters & { order: ShowOrder; mode: ShowMode }>
) {
  const params = new URLSearchParams(current);
  for (const [key, value] of Object.entries(changes)) {
    if (key === "tag") {
      params.delete(key);
      for (const tag of tagFilterValues(value)) params.append("tag", tag);
    } else if (typeof value === "string" && value) params.set(key, value);
    else params.delete(key);
  }
  return params;
}

export function imageBrowseApiSearchParams(
  filters: GalleryFilters,
  order: ShowOrder,
  options: { view: PublicImageView; limit?: number; cursor?: string; userAgent?: string }
) {
  const params = galleryApiFilters(filters, options.userAgent ?? "");
  if (options.cursor) params.set("cursor", options.cursor);
  params.set("order", order);
  params.set("view", options.view);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  params.sort();
  return params;
}

export function galleryRandomRequestDevice(device: string) {
  if (device === "auto") return "";
  if (device === "pc" || device === "mb") return device;
  return "all";
}

export function galleryHref(
  filters: GalleryFilters,
  pathname: "/show" | "/gallery" | "/embed/show" | "/embed/gallery" = "/gallery"
) {
  const query = readableFilterSearch(galleryRouteSearchParams(filters));
  return query ? `${pathname}?${query}` : pathname;
}
