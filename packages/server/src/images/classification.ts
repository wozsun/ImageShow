import type { Brightness, Device } from "@imageshow/shared";

export type DeviceSelection = Device | "auto";
export type BrightnessSelection = Brightness | "auto";

export type ClassificationSelection = {
  device: DeviceSelection;
  brightness: BrightnessSelection;
};

export type DetectedClassification = {
  device: Device;
  brightness: Brightness;
};

export function deviceFromDimensions(width: string | number | null | undefined, height: string | number | null | undefined): Device | undefined {
  const actualWidth = Number(width ?? 0);
  const actualHeight = Number(height ?? 0);
  if (actualWidth <= 0 || actualHeight <= 0) return undefined;
  return actualWidth >= actualHeight ? "pc" : "mb";
}

function resolveDevice(input: DeviceSelection, detected: Device): Device {
  return input === "auto" ? detected : input;
}

export function resolveOptionalDeviceWith(input: DeviceSelection | undefined, detect: () => Device | undefined): Device | undefined {
  if (input === undefined) return undefined;
  return input === "auto" ? detect() : input;
}

function resolveBrightness(input: BrightnessSelection, detected: Brightness): Brightness {
  return input === "auto" ? detected : input;
}

export async function resolveOptionalBrightnessWith(input: BrightnessSelection | undefined, detect: () => Promise<Brightness | undefined>): Promise<Brightness | undefined> {
  if (input === undefined) return undefined;
  return input === "auto" ? await detect() : input;
}

export function resolveClassification(
  input: ClassificationSelection,
  detected: DetectedClassification
): DetectedClassification {
  return {
    device: resolveDevice(input.device, detected.device),
    brightness: resolveBrightness(input.brightness, detected.brightness)
  };
}
