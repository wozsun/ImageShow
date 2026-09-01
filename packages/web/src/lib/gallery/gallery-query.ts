import { detectDeviceFromUserAgent } from "@imageshow/shared/browser";

export type GalleryFilters = {
  device: string;
  brightness: string;
  theme: string;
  tag: string;
  author: string;
};

const galleryDevices = new Set(["pc", "mb", "auto"]);
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
  const device = params.get("device")?.trim().toLowerCase() ?? "";
  const brightness = params.get("brightness")?.trim().toLowerCase() ?? "";
  return {
    device: device === "all" ? "" : galleryDevices.has(device) ? device : "",
    brightness: galleryBrightnesses.has(brightness) ? brightness : "",
    theme: selectorValue(params, "theme"),
    tag: selectorValue(params, "tag"),
    author: selectorValue(params, "author")
  };
}

export function galleryRouteSearchParams(filters: GalleryFilters) {
  const params = new URLSearchParams();
  if (galleryDevices.has(filters.device)) params.set("device", filters.device);
  if (filters.brightness) params.set("brightness", filters.brightness);
  if (filters.theme) params.set("theme", filters.theme);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.author) params.set("author", filters.author);
  return params;
}

export function galleryApiSearchParams(
  filters: GalleryFilters,
  order: string,
  options: { cursor?: string; userAgent?: string } = {}
) {
  const params = new URLSearchParams();
  const projectedDevice = filters.device === "auto"
    ? detectDeviceFromUserAgent(options.userAgent ?? "")
    : filters.device;
  if (projectedDevice === "pc" || projectedDevice === "mb") {
    params.set("device", projectedDevice);
  }
  if (filters.brightness) params.set("brightness", filters.brightness);
  if (filters.theme) params.set("theme", filters.theme);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.author) params.set("author", filters.author);
  if (options.cursor) params.set("cursor", options.cursor);
  if (order === "random") params.set("shuffle", "1");
  return params;
}

export function galleryRandomRequestDevice(device: string) {
  if (device === "auto") return "";
  if (device === "pc" || device === "mb") return device;
  return "all";
}

export function galleryHref(
  filters: GalleryFilters,
  pathname: "/gallery" | "/embed/gallery" = "/gallery"
) {
  const query = galleryRouteSearchParams(filters).toString();
  return query ? `${pathname}?${query}` : pathname;
}
