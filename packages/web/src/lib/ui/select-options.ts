export type SelectOption = { value: string; label: string };

const deviceLabels: Record<string, string> = { pc: "桌面端", mb: "移动端" };
const brightnessLabels: Record<string, string> = { dark: "暗色图片", light: "亮色图片" };

export function deviceOptionLabel(value: string) {
  return deviceLabels[value] ?? value;
}

export function brightnessOptionLabel(value: string) {
  return brightnessLabels[value] ?? value;
}

export const cardDeviceSelectOptions: readonly SelectOption[] = [
  { value: "pc", label: deviceOptionLabel("pc") },
  { value: "mb", label: deviceOptionLabel("mb") }
];

export const cardBrightnessSelectOptions: readonly SelectOption[] = [
  { value: "auto", label: "自动亮暗" },
  { value: "light", label: brightnessOptionLabel("light") },
  { value: "dark", label: brightnessOptionLabel("dark") }
];

export const uploadCommonDeviceOptions: readonly SelectOption[] = [
  { value: "", label: "自动设备" },
  { value: "pc", label: deviceOptionLabel("pc") },
  { value: "mb", label: deviceOptionLabel("mb") }
];

export const uploadCommonBrightnessOptions: readonly SelectOption[] = [
  { value: "", label: "自动亮暗" },
  { value: "light", label: brightnessOptionLabel("light") },
  { value: "dark", label: brightnessOptionLabel("dark") }
];

export const batchCommonDeviceOptions: readonly SelectOption[] = [
  { value: "", label: "设备不变" },
  { value: "auto", label: "自动设备" },
  { value: "pc", label: deviceOptionLabel("pc") },
  { value: "mb", label: deviceOptionLabel("mb") }
];

export const batchCommonBrightnessOptions: readonly SelectOption[] = [
  { value: "", label: "亮暗不变" },
  { value: "auto", label: "自动亮暗" },
  { value: "light", label: brightnessOptionLabel("light") },
  { value: "dark", label: brightnessOptionLabel("dark") }
];

export const randomDeviceSelectOptions: readonly SelectOption[] = [
  { value: "", label: "自动识别" },
  { value: "r", label: "强制随机" },
  { value: "pc", label: deviceOptionLabel("pc") },
  { value: "mb", label: deviceOptionLabel("mb") }
];

export const randomBrightnessSelectOptions: readonly SelectOption[] = [
  { value: "random", label: "随机亮度" },
  { value: "light", label: "亮色图片" },
  { value: "dark", label: "暗色图片" }
];

export const randomModeSelectOptions: readonly SelectOption[] = [
  { value: "", label: "默认模式" },
  { value: "redirect", label: "302 跳转" },
  { value: "proxy", label: "代理模式" }
];

export const galleryOrderSelectOptions: readonly SelectOption[] = [
  { value: "latest", label: "最新优先" },
  { value: "random", label: "随机打乱" }
];

const storageBackendLabels: Record<string, string> = { local: "本地存储" };

export function storageBackendLabel(value: string) {
  return storageBackendLabels[value] ?? value;
}

export function storageBackendDisplay(backend: { slug: string; display_name?: string }) {
  return backend.display_name || storageBackendLabel(backend.slug);
}

const storageTypeLabels: Record<string, string> = { local: "本地", s3: "对象存储", webdav: "WebDAV" };

export function storageTypeLabel(type: string) {
  return storageTypeLabels[type] ?? type;
}
