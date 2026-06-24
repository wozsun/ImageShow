export type SelectOption = { value: string; label: string };

const deviceLabels: Record<string, string> = { none: "未设置", pc: "桌面端", mb: "移动端" };
const brightnessLabels: Record<string, string> = { none: "未设置", dark: "暗色图片", light: "亮色图片" };

export function deviceOptionLabel(value: string) {
  return deviceLabels[value] ?? value;
}

export function brightnessOptionLabel(value: string) {
  return brightnessLabels[value] ?? value;
}

export const deviceSelectOptions: readonly SelectOption[] = [
  { value: "none", label: deviceOptionLabel("none") },
  { value: "pc", label: deviceOptionLabel("pc") },
  { value: "mb", label: deviceOptionLabel("mb") }
];

export const brightnessSelectOptions: readonly SelectOption[] = [
  { value: "none", label: brightnessOptionLabel("none") },
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

const storageBackendLabels: Record<string, string> = { local: "本地存储", s3: "对象存储" };

export function storageBackendLabel(value: string) {
  return storageBackendLabels[value] ?? value;
}

const storageBackendShortLabels: Record<string, string> = { local: "本地", s3: "S3" };

export function storageBackendShortLabel(value: string) {
  return storageBackendShortLabels[value] ?? value;
}

export const storageBackendSelectOptions: readonly SelectOption[] = [
  { value: "local", label: storageBackendLabel("local") },
  { value: "s3", label: storageBackendLabel("s3") }
];
