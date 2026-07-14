import type { Brightness, ImageDraft } from "../types.js";

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

export type CommonImageAttributes = { device: string; brightness: string; theme: string; author: string; tags: string[] };

export function mergeBatchEditCommonAttributes(draft: ImageDraft, common: CommonImageAttributes): ImageDraft {
  return {
    ...draft,
    ...(common.device ? { device: common.device as ImageDraft["device"] } : {}),
    ...(common.brightness ? { brightness: common.brightness as ImageDraft["brightness"] } : {}),
    ...(common.theme.trim() ? { theme: common.theme } : {}),
    ...(common.author.trim() ? { author: common.author } : {}),
    ...(common.tags.length ? { tags: [...new Set([...draft.tags, ...common.tags])] } : {})
  };
}

export function resolveUploadDefaultBrightness(value: string, fallback: Brightness | "auto"): Brightness | "auto" {
  // 新任务默认“自动亮暗”表示不强制指定，使用服务端检测结果。
  return value === "dark" || value === "light" ? value : fallback;
}

export function browserUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

export async function draftFromFile(_file: File, defaults: CommonImageAttributes, previewUrl: string) {
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

function applyUploadDefaults(inferred: ImageDraft, defaults: CommonImageAttributes): ImageDraft {
  return {
    ...inferred,
    device: defaults.device ? (defaults.device as ImageDraft["device"]) : inferred.device,
    brightness: resolveUploadDefaultBrightness(defaults.brightness, inferred.brightness),
    theme: defaults.theme.trim() ? defaults.theme.trim().toLowerCase() : inferred.theme,
    author: defaults.author.trim() ? defaults.author.trim().toLowerCase() : inferred.author,
    tags: defaults.tags.length ? [...new Set([...inferred.tags, ...defaults.tags])] : inferred.tags
  };
}
