import type { Brightness, Device } from "@imageshow/shared";

export type DeviceSelection = Device | "auto";
export type BrightnessSelection = Brightness | "auto";

export type ClassificationSelection = {
  device: DeviceSelection;
  brightness: BrightnessSelection;
};

export type ResolvedClassification = {
  device: Device;
  brightness: Brightness;
};

export function deviceFromDimensions(width: string | number | null | undefined, height: string | number | null | undefined): Device | undefined {
  const actualWidth = Number(width ?? 0);
  const actualHeight = Number(height ?? 0);
  if (actualWidth <= 0 || actualHeight <= 0) return undefined;
  return actualWidth >= actualHeight ? "pc" : "mb";
}

function resolveDevice(input: DeviceSelection, resolved: Device): Device {
  return input === "auto" ? resolved : input;
}

export function resolveDeviceWith(input: DeviceSelection, detect: () => Device): Device {
  return input === "auto" ? detect() : input;
}

export function resolveOptionalDeviceWith(input: DeviceSelection | undefined, detect: () => Device | undefined): Device | undefined {
  if (input === undefined) return undefined;
  return input === "auto" ? detect() : input;
}

function resolveBrightness(input: BrightnessSelection, resolved: Brightness): Brightness {
  return input === "auto" ? resolved : input;
}

export async function resolveBrightnessWith(input: BrightnessSelection, detect: () => Promise<Brightness>): Promise<Brightness> {
  return input === "auto" ? await detect() : input;
}

export async function resolveOptionalBrightnessWith(input: BrightnessSelection | undefined, detect: () => Promise<Brightness | undefined>): Promise<Brightness | undefined> {
  if (input === undefined) return undefined;
  return input === "auto" ? await detect() : input;
}

export function resolveClassification(input: ClassificationSelection, resolved: ResolvedClassification): ResolvedClassification {
  return {
    device: resolveDevice(input.device, resolved.device),
    brightness: resolveBrightness(input.brightness, resolved.brightness)
  };
}
