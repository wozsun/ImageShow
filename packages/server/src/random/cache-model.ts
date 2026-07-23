import type { Brightness, Device } from "@imageshow/shared";

export type RandomCategoryCounts = Record<
  string,
  Record<string, Record<string, number>>
>;

export type GalleryFilterOptions = {
  devices: string[];
  brightnesses: string[];
  themes: string[];
};

export type RandomPoolSnapshot = {
  generation: string;
  categoryCounts: RandomCategoryCounts;
  themes: string[];
};

export type RandomPoolItem = {
  id: string;
  object_key: string;
  ext: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  storage_slug: string;
  author: string;
  tags: string[];
};

const randomPoolItemFields = new Set<keyof RandomPoolItem>([
  "id",
  "object_key",
  "ext",
  "device",
  "brightness",
  "theme",
  "storage_slug",
  "author",
  "tags"
]);

export function parseRandomPoolItem(raw: string | null): RandomPoolItem | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RandomPoolItem>;
    if (
      Object.keys(value).some(
        (field) => !randomPoolItemFields.has(field as keyof RandomPoolItem)
      )
      || typeof value.id !== "string" || !value.id
      || typeof value.object_key !== "string" || !value.object_key
      || typeof value.ext !== "string"
      || !["jpg", "png", "webp", "gif", "avif"].includes(value.ext)
      || !["pc", "mb"].includes(String(value.device))
      || !["dark", "light"].includes(String(value.brightness))
      || typeof value.theme !== "string"
      || typeof value.storage_slug !== "string" || !value.storage_slug
      || typeof value.author !== "string"
      || !Array.isArray(value.tags)
      || value.tags.length > 50
      || value.tags.some((tag) => typeof tag !== "string")
    ) {
      return null;
    }
    return value as RandomPoolItem;
  } catch {
    return null;
  }
}

export function adjustCategoryCounts(
  counts: RandomCategoryCounts,
  item: Pick<RandomPoolItem, "device" | "brightness" | "theme">,
  delta: number
) {
  counts[item.device] ??= {};
  counts[item.device][item.brightness] ??= {};
  counts[item.device][item.brightness][item.theme] = Math.max(
    0,
    Number(counts[item.device][item.brightness][item.theme] ?? 0) + delta
  );
  if (delta < 0) pruneEmptyCategoryCounts(counts);
}

function pruneEmptyCategoryCounts(counts: RandomCategoryCounts) {
  for (const [device, deviceMap] of Object.entries(counts)) {
    for (const [brightness, brightnessMap] of Object.entries(deviceMap)) {
      for (const [theme, count] of Object.entries(brightnessMap)) {
        if (!Number.isFinite(Number(count)) || Number(count) <= 0) {
          delete brightnessMap[theme];
        }
      }
      if (!Object.keys(brightnessMap).length) delete deviceMap[brightness];
    }
    if (!Object.keys(deviceMap).length) delete counts[device];
  }
}

export function filterOptionsFromCategoryCounts(
  counts: RandomCategoryCounts
): GalleryFilterOptions {
  const themes = new Set<string>();
  for (const device of Object.values(counts)) {
    for (const brightness of Object.values(device)) {
      for (const theme of Object.keys(brightness)) themes.add(theme);
    }
  }
  return {
    devices: ["pc", "mb"],
    brightnesses: ["light", "dark"],
    themes: [...themes].sort()
  };
}

export function randomPoolItemsFromRows(
  rows: Array<Record<string, unknown>>
): RandomPoolItem[] {
  return rows.map((row) => ({
    id: String(row.id),
    object_key: String(row.object_key),
    ext: String(row.ext),
    device: row.device as Device,
    brightness: row.brightness as Brightness,
    theme: String(row.theme),
    storage_slug: String(row.storage_slug),
    author: typeof row.author === "string" ? row.author : "",
    tags: Array.isArray(row.tags) ? row.tags as string[] : []
  }));
}
