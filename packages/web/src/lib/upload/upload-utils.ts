import type { Brightness, Device, ImageDraft } from "../types.js";

export async function runWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
}

const defaultDraft: ImageDraft = {
  device: "auto",
  brightness: "auto",
  theme: "",
  author: "",
  title: "",
  description: "",
  source: "",
  original: "",
  tags: []
};

export type ImportAttributeDefaults = {
  device: Device | "auto";
  brightness: Brightness | "auto";
  theme: string;
  author: string;
  tags: string[];
};

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

export function webUuidV7(now = Date.now()) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random values are unavailable");
  }
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new RangeError("UUIDv7 timestamp is outside the 48-bit range");
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let timestamp = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let lastImportBatchTimestamp = -1;

/**
 * Keep batch UUIDs strictly time-ordered inside one browser document, including
 * multiple selections created within the same millisecond.
 */
export function webImportBatchKey(now = Date.now()) {
  const timestamp = Math.max(now, lastImportBatchTimestamp + 1);
  const batchKey = webUuidV7(timestamp);
  lastImportBatchTimestamp = timestamp;
  return batchKey;
}

export function normalizeTheme(value: string) {
  return value.trim().toLowerCase() || "none";
}

export function normalizeAuthor(value: string) {
  return value.trim().toLowerCase();
}

function fileExt(file: File) {
  return (file.name.split(".").pop() || "").toLowerCase();
}

export function isUploadableImage(file: File) {
  return file.type.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(fileExt(file));
}

export async function draftFromFile(
  _file: File,
  defaults: ImportAttributeDefaults,
  previewUrl: string
) {
  const image = await loadImageDimensions(previewUrl);
  return { draft: applyUploadDefaults({
    ...defaultDraft,
    device: "auto",
    brightness: "auto",
    theme: ""
  }, defaults), width: image.width, height: image.height };
}

async function loadImageDimensions(previewUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    const finish = (width = 0, height = 0) => {
      window.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      resolve({ width, height });
    };
    const timeout = window.setTimeout(() => finish(), 2000);
    image.onload = () => finish(image.naturalWidth, image.naturalHeight);
    image.onerror = () => finish();
    image.src = previewUrl;
  });
}

function applyUploadDefaults(
  inferred: ImageDraft,
  defaults: ImportAttributeDefaults
): ImageDraft {
  return {
    ...inferred,
    device: defaults.device,
    brightness: defaults.brightness,
    theme: defaults.theme.trim() ? defaults.theme.trim().toLowerCase() : inferred.theme,
    author: defaults.author.trim() ? defaults.author.trim().toLowerCase() : inferred.author,
    tags: defaults.tags.length ? [...new Set([...inferred.tags, ...defaults.tags])] : inferred.tags
  };
}
