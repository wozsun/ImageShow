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
  device: "pc",
  brightness: "auto",
  theme: "",
  author: "",
  title: "",
  description: "",
  source: "",
  original: "",
  tags: []
};

export type CommonAttributes = { device: string; brightness: string; theme: string; author: string; tags: string[] };

export function applyCommonAttributes(draft: ImageDraft, common: CommonAttributes): ImageDraft {
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
  // 上传窗口顶部的“自动亮暗”表示“不强制覆盖”，应优先使用文件名或服务端检测结果。
  return value === "dark" || value === "light" ? value : fallback;
}

export function browserUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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

export async function draftFromFile(file: File, defaults: CommonAttributes, previewUrl: string) {
  const structured = metadataFromFilename(file.name);
  const image = await imageInfo(previewUrl);
  const detected: { device: Device; brightness: Brightness | "auto" } = {
    device: structured.device ?? image.device,
    brightness: structured.brightness ?? "auto"
  };
  return { draft: applyUploadDefaults({
    ...defaultDraft,
    device: detected.device,
    brightness: detected.brightness,
    theme: structured.theme ?? ""
  }, defaults), detected, width: image.width, height: image.height };
}

function metadataFromFilename(filename: string): Partial<ImageDraft> {
  const stem = filename.replace(/\.[^.]+$/, "").toLowerCase();
  const full = /^(pc|mb)-(dark|light)-([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-\d+$/i.exec(stem);
  if (full) return { device: full[1] as Device, brightness: full[2] as ImageDraft["brightness"], theme: full[3].toLowerCase() };
  const partial = /^(pc|mb)-(dark|light)-\d+$/i.exec(stem);
  if (partial) return { device: partial[1] as Device, brightness: partial[2] as ImageDraft["brightness"] };
  return {};
}

async function imageInfo(previewUrl: string): Promise<{ device: Device; width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    const finish = (device: Device, width = 0, height = 0) => {
      window.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      resolve({ device, width, height });
    };
    const timeout = window.setTimeout(() => finish("pc"), 2000);
    image.onload = () => finish(image.naturalWidth >= image.naturalHeight ? "pc" : "mb", image.naturalWidth, image.naturalHeight);
    image.onerror = () => finish("pc");
    image.src = previewUrl;
  });
}

function applyUploadDefaults(inferred: ImageDraft, defaults: CommonAttributes): ImageDraft {
  return {
    ...inferred,
    device: defaults.device ? (defaults.device as ImageDraft["device"]) : inferred.device,
    brightness: resolveUploadDefaultBrightness(defaults.brightness, inferred.brightness),
    theme: defaults.theme.trim() ? defaults.theme.trim().toLowerCase() : inferred.theme,
    author: defaults.author.trim() ? defaults.author.trim().toLowerCase() : inferred.author,
    tags: defaults.tags.length ? [...new Set([...inferred.tags, ...defaults.tags])] : inferred.tags
  };
}
