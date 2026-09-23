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
  type ShowMode,
  type ShowOrder,
  type PublicImageView,
  type TagFilterValue
} from "@imageshow/shared/browser";

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
const selectorPattern = /^!?[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export const emptyGalleryFilters: GalleryFilters = {
  device: "",
  brightness: "",
  theme: "",
  tag: "",
  author: ""
};

function selectorValue(params: URLSearchParams, key: string) {
  const tokens = [...new Set(
    params.getAll(key)
      .flatMap((value) => value.split(","))
      .map((value) => value.trim().toLowerCase())
      .filter((value) => selectorPattern.test(value))
  )];
  const hasIncludes = tokens.some((value) => !value.startsWith("!"));
  const hasExcludes = tokens.some((value) => value.startsWith("!"));
  return hasIncludes && hasExcludes ? "" : tokens.sort().join(",");
}

export function galleryFiltersFromSearchParams(
  params: URLSearchParams,
  tags?: readonly { slug: string; display_name: string }[]
): GalleryFilters {
  const device = params.get("device")?.trim().toLowerCase() ?? "";
  const brightness = params.get("brightness")?.trim().toLowerCase() ?? "";
  const values = params.getAll("tag");
  parseGalleryTagFilter(values);
  const map = tags ? new Map(tags.map((tag) => [tag.display_name.trim().toLowerCase(), tag.slug])) : null;
  for (const tag of tags ?? []) map!.set(tag.slug, tag.slug);
  const normalizedTags = values.map((value) => {
    const parsed = parseTagFilter([value]);
    const expression = map ? resolveTagExpression(parsed.expression, map) : parsed.expression;
    return basicTagValue(expression?.anyOf.flat() ?? [], parsed.mode);
  });
  parseGalleryTagFilter(normalizedTags);
  return {
    device: device === "all" ? "" : galleryDevices.has(device) ? device : "",
    brightness: galleryBrightnesses.has(brightness) ? brightness : "",
    theme: selectorValue(params, "theme"),
    tag: normalizedTags.length > 1 ? normalizedTags : normalizedTags[0] ?? "",
    author: selectorValue(params, "author")
  };
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
function galleryApiFilters(filters: GalleryFilters, userAgent: string) {
  const params = galleryRouteSearchParams({
    ...filters,
    device: filters.device === "auto" ? detectDeviceFromUserAgent(userAgent) ?? "" : filters.device
  }, false);
  for (const field of ["theme", "author"] as const) {
    const value = selectorValue(params, field);
    if (value) params.set(field, value);
    else params.delete(field);
  }
  return params;
}

/** Page URLs retain authored tag groups and their order. */
export function galleryStatsSearch(filters: GalleryFilters, userAgent = "") {
  return readableFilterSearch(galleryApiFilters(filters, userAgent));
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
