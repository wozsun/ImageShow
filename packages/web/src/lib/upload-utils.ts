import type { Brightness, Device, ImageDraft } from "./types.js";

const defaultDraft: ImageDraft = {
  device: "none",
  brightness: "none",
  theme: "",
  title: "",
  description: "",
  source: "",
  original: ""
};

// The device/brightness/theme chosen in an "apply to all" control. A blank field
// (empty string) is "no override"; any concrete value (including "none" = 未设置)
// is applied. Used by the uploader's default bar (where blank re-derives each
// file's auto-detected value) and the batch editor's common row (where blank =
// 保持不变, leaving each row untouched).
export type CommonAttributes = { device: string; brightness: string; theme: string };

// Overlays only the non-blank fields of `common` onto a draft, preserving the
// draft's own value for fields left blank. Used by the batch editor's "应用到全部"
// (blank = 保持不变); the uploader re-derives detected values for blanks instead.
export function applyCommonAttributes(draft: ImageDraft, common: CommonAttributes): ImageDraft {
  return {
    ...draft,
    ...(common.device ? { device: common.device as ImageDraft["device"] } : {}),
    ...(common.brightness ? { brightness: common.brightness as ImageDraft["brightness"] } : {}),
    ...(common.theme.trim() ? { theme: common.theme } : {})
  };
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

export function fileExt(file: File) {
  return (file.name.split(".").pop() || "").toLowerCase();
}

export function isUploadableImage(file: File) {
  return file.type.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(fileExt(file));
}

export function titleFromFile(file: File) {
  return file.name.replace(/\.[^.]+$/, "");
}

export async function draftFromFile(file: File, defaults: CommonAttributes, previewUrl: string) {
  const structured = metadataFromFilename(file.name);
  const image = await imageInfo(previewUrl);
  // The attributes detected straight from the filename/aspect ratio, kept aside so
  // the uploader's "自动识别" apply-to-all can re-derive them later regardless of any
  // manual edits or non-blank defaults layered on top.
  const detected: { device: Device; brightness: Brightness } = {
    device: structured.device ?? image.device,
    brightness: structured.brightness ?? "none"
  };
  return { draft: applyUploadDefaults({
    ...defaultDraft,
    title: titleFromFile(file),
    device: detected.device,
    brightness: detected.brightness,
    theme: structured.theme ?? ""
  }, defaults), detected, width: image.width, height: image.height };
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

type Md5Task = { id: string; buffer: ArrayBuffer; resolve: (md5: string) => void; reject: (error: Error) => void };
type Md5WorkerSlot = { worker: Worker; task: Md5Task | null };
const md5Queue: Md5Task[] = [];
const md5Workers: Md5WorkerSlot[] = [];
const md5WorkerCount = Math.max(2, Math.min(4, typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency || 2));

function createMd5WorkerSlot(): Md5WorkerSlot {
  const slot: Md5WorkerSlot = { worker: new Worker(new URL("../workers/md5.worker.ts", import.meta.url), { type: "module" }), task: null };
  slot.worker.onmessage = (event: MessageEvent<{ id: string; md5: string }>) => {
    if (!slot.task || slot.task.id !== event.data.id) return;
    slot.task.resolve(event.data.md5);
    slot.task = null;
    dispatchMd5Tasks();
  };
  slot.worker.onerror = (event) => {
    slot.task?.reject(new Error(event.message || "MD5 worker failed"));
    slot.worker.terminate();
    slot.task = null;
    const index = md5Workers.indexOf(slot);
    if (index >= 0) md5Workers[index] = createMd5WorkerSlot();
    dispatchMd5Tasks();
  };
  return slot;
}

function dispatchMd5Tasks() {
  while (md5Workers.length < md5WorkerCount) md5Workers.push(createMd5WorkerSlot());
  for (const slot of md5Workers) {
    if (slot.task) continue;
    const task = md5Queue.shift();
    if (!task) break;
    slot.task = task;
    slot.worker.postMessage({ id: task.id, buffer: task.buffer }, [task.buffer]);
  }
}

export async function md5File(file: File) {
  const buffer = await file.arrayBuffer();
  return new Promise<string>((resolve, reject) => {
    md5Queue.push({ id: browserUuid(), buffer, resolve, reject });
    dispatchMd5Tasks();
  });
}

export function putFileWithProgress(url: string, headers: Headers, file: File, onProgress: (progress: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    headers.forEach((value, key) => request.setRequestHeader(key, value));
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve();
        return;
      }
      // S3/COS report a body-integrity mismatch as BadDigest when the signed
      // Content-MD5 doesn't match the bytes received; surface that plainly.
      const code = /<Code>([^<]+)<\/Code>/.exec(request.responseText || "")?.[1] ?? "";
      if (code === "BadDigest" || code === "InvalidDigest") {
        reject(new Error("对象存储校验失败：文件可能在传输中损坏，请重试"));
        return;
      }
      reject(new Error(code ? `上传失败（${code}，HTTP ${request.status}）` : `上传失败（HTTP ${request.status}）`));
    };
    request.onerror = () => reject(new Error("上传网络请求失败"));
    request.onabort = () => reject(new Error("上传已取消"));
    request.send(file);
  });
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
    const timeout = window.setTimeout(() => finish("none"), 2000);
    image.onload = () => finish(image.naturalWidth >= image.naturalHeight ? "pc" : "mb", image.naturalWidth, image.naturalHeight);
    image.onerror = () => finish("none");
    image.src = previewUrl;
  });
}

// Overlays the apply-to-all defaults onto a freshly inferred draft. A blank field
// ("" = 自动识别) keeps the value detected from the file/filename; any concrete
// value (including "none" = 未设置) overrides it, so "未设置" can be applied too.
function applyUploadDefaults(inferred: ImageDraft, defaults: CommonAttributes): ImageDraft {
  return {
    ...inferred,
    device: defaults.device ? (defaults.device as ImageDraft["device"]) : inferred.device,
    brightness: defaults.brightness ? (defaults.brightness as ImageDraft["brightness"]) : inferred.brightness,
    theme: defaults.theme.trim() ? defaults.theme.trim().toLowerCase() : inferred.theme
  };
}
