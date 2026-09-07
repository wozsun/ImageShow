import { detectDeviceFromUserAgent } from "@imageshow/shared/browser";
import type { GalleryFilters } from "../../lib/gallery/gallery-query.js";
import type { EditableImageSnapshot } from "../../lib/types.js";
import type { ShowImage } from "./show-layout.js";

function selectorTerms(value: string) {
  return value.split(",").map((term) => term.trim()).filter(Boolean);
}

function matchesSelector(values: readonly string[], selector: string) {
  const terms = selectorTerms(selector);
  if (!terms.length) return true;
  const excluded = terms[0]!.startsWith("!");
  const selected = terms.map((term) => excluded ? term.slice(1) : term);
  return excluded
    ? selected.every((term) => !values.includes(term))
    : selected.some((term) => values.includes(term));
}

/** Mirrors the normalized public-list/random membership semantics in-browser. */
export function showImageMatchesFilters(
  image: Pick<
    ShowImage,
    "author" | "brightness" | "device" | "tags" | "theme"
  >,
  filters: GalleryFilters,
  userAgent: string
) {
  const detectedDevice = filters.device === "auto"
    ? detectDeviceFromUserAgent(userAgent)
    : null;
  const selectedDevice = filters.device === "pc" || filters.device === "mb"
    ? filters.device
    : detectedDevice;
  return (!selectedDevice || image.device === selectedDevice)
    && (!filters.brightness || image.brightness === filters.brightness)
    && matchesSelector([image.theme], filters.theme)
    && matchesSelector(image.tags, filters.tag)
    && matchesSelector([image.author], filters.author);
}

/** Keeps stream-only fields while applying the editor's authoritative DTO. */
export function updatedShowImage(
  current: ShowImage,
  snapshot: EditableImageSnapshot
): ShowImage {
  return {
    ...current,
    title: snapshot.title,
    device: snapshot.device,
    brightness: snapshot.brightness,
    theme: snapshot.theme,
    author: snapshot.author,
    thumb_url: snapshot.thumb_url,
    width: snapshot.width,
    height: snapshot.height,
    tags: snapshot.tags,
    object_url: snapshot.object_url
  };
}
