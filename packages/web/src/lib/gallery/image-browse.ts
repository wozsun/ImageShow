import { unsetThemeFilter } from "@imageshow/shared/browser";
import { detectDeviceFromUserAgent, type EditableImageSnapshotDto } from "@imageshow/shared/browser";
import type { GalleryFilters } from "./gallery-query.js";

function matchesSelector(values: readonly string[], selector: string) {
  const terms = selector.split(",").map((term) => term.trim()).filter(Boolean);
  if (!terms.length) return true;
  const excluded = terms[0]!.startsWith("!");
  const selected = terms.map((term) => excluded ? term.slice(1) : term);
  return excluded
    ? selected.every((term) => !values.includes(term))
    : selected.some((term) => values.includes(term));
}

export function imageMatchesFilters(
  image: Pick<EditableImageSnapshotDto, "author" | "brightness" | "device" | "tags" | "theme">,
  filters: GalleryFilters,
  userAgent: string
) {
  const device = filters.device === "auto"
    ? detectDeviceFromUserAgent(userAgent) : filters.device;
  return (!device || image.device === device)
    && (!filters.brightness || image.brightness === filters.brightness)
    && matchesSelector([image.theme ?? unsetThemeFilter], filters.theme)
    && matchesSelector(image.tags, filters.tag)
    && matchesSelector([image.author], filters.author);
}

/** A new presentation order for one accepted HTTP batch; never mutates its entity. */
export function shuffledImageBatch<T>(items: readonly T[], random = Math.random): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

export function imageBatchTier(required: number, tiers: readonly number[]) {
  return tiers.find((tier) => tier >= required) ?? tiers[tiers.length - 1]!;
}
