export type GalleryFilters = {
  device: string;
  brightness: string;
  theme: string;
  tag: string;
  author: string;
};

const galleryDevices = new Set(["pc", "mb", "r"]);
const galleryBrightnesses = new Set(["dark", "light"]);
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
  return hasIncludes && hasExcludes ? "" : tokens.join(",");
}

export function galleryFiltersFromSearchParams(
  params: URLSearchParams
): GalleryFilters {
  const device = params.get("d")?.trim().toLowerCase() ?? "";
  const brightness = params.get("b")?.trim().toLowerCase() ?? "";
  return {
    device: galleryDevices.has(device) ? device : "",
    brightness: galleryBrightnesses.has(brightness) ? brightness : "",
    theme: selectorValue(params, "t"),
    tag: selectorValue(params, "tag"),
    author: selectorValue(params, "a")
  };
}

export function galleryRouteSearchParams(filters: GalleryFilters) {
  const params = new URLSearchParams();
  if (filters.device) params.set("d", filters.device);
  if (filters.brightness) params.set("b", filters.brightness);
  if (filters.theme) params.set("t", filters.theme);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.author) params.set("a", filters.author);
  return params;
}

export function galleryApiSearchParams(
  filters: GalleryFilters,
  order: string,
  cursor = ""
) {
  const params = galleryRouteSearchParams(filters);
  if (filters.device === "r") params.delete("d");
  if (cursor) params.set("cursor", cursor);
  if (order === "random") params.set("shuffle", "1");
  return params;
}

export function galleryHref(
  filters: GalleryFilters,
  pathname: "/gallery" | "/embed/gallery" = "/gallery"
) {
  const query = galleryRouteSearchParams(filters).toString();
  return query ? `${pathname}?${query}` : pathname;
}
