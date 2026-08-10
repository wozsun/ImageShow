import {
  galleryOrders,
  type GalleryOrder
} from "@imageshow/shared/browser";

export type SelectOption = { value: string; label: string };

const deviceLabels: Record<string, string> = { pc: "桌面端", mb: "移动端" };
const brightnessLabels: Record<string, string> = { dark: "暗色图片", light: "亮色图片" };

export function deviceOptionLabel(value: string) {
  return deviceLabels[value] ?? value;
}

export function brightnessOptionLabel(value: string) {
  return brightnessLabels[value] ?? value;
}

const cardDeviceSelectOptions: readonly SelectOption[] = [
  { value: "pc", label: deviceOptionLabel("pc") },
  { value: "mb", label: deviceOptionLabel("mb") }
];

export const editCardDeviceSelectOptions: readonly SelectOption[] = [
  { value: "auto", label: "自动设备" },
  ...cardDeviceSelectOptions
];

export function importCardDeviceSelectOptions(
  value: string,
  automaticLabel: string
): readonly SelectOption[] {
  return value === "auto"
    ? [{ value: "auto", label: automaticLabel }, ...cardDeviceSelectOptions]
    : cardDeviceSelectOptions;
}

const manualBrightnessSelectOptions: readonly SelectOption[] = [
  { value: "light", label: brightnessOptionLabel("light") },
  { value: "dark", label: brightnessOptionLabel("dark") }
];

export const cardBrightnessSelectOptions: readonly SelectOption[] = [
  { value: "auto", label: "自动亮暗" },
  ...manualBrightnessSelectOptions
];

export function importCardBrightnessSelectOptions(
  value: string,
  automaticLabel: string
): readonly SelectOption[] {
  return value === "auto"
    ? [{ value: "auto", label: automaticLabel }, ...manualBrightnessSelectOptions]
    : manualBrightnessSelectOptions;
}

export const uploadCommonDeviceOptions: readonly SelectOption[] = [
  { value: "auto", label: "自动设备" },
  { value: "pc", label: deviceOptionLabel("pc") },
  { value: "mb", label: deviceOptionLabel("mb") }
];

export const uploadCommonBrightnessOptions: readonly SelectOption[] = [
  { value: "auto", label: "自动亮暗" },
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

const galleryOrderLabels: Record<GalleryOrder, string> = {
  latest: "最新优先",
  random: "随机打乱"
};

export const galleryOrderSelectOptions: readonly SelectOption[] =
  galleryOrders.map((value) => ({
    value,
    label: galleryOrderLabels[value]
  }));

const storageBackendLabels: Record<string, string> = { local: "本地存储" };

export function storageBackendLabel(value: string) {
  return storageBackendLabels[value] ?? value;
}

export function storageBackendDisplay(backend: { slug: string; display_name?: string }) {
  return backend.display_name || storageBackendLabel(backend.slug);
}

const storageTypeLabels: Record<string, string> = { local: "本地", s3: "对象存储" };

export function storageTypeLabel(type: string) {
  return storageTypeLabels[type] ?? type;
}
