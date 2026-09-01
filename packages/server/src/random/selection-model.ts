import {
  detectDeviceFromUserAgent,
  type Device
} from "@imageshow/shared/browser";
import type { ReadyImageCacheItem } from "../images/ready-cache/model.ts";
import {
  isRandomBrightness,
  randomBrightnesses,
  randomDevices,
  type RandomBrightness,
  type RandomRequestDevice
} from "./query.ts";

export type SelectedReadyImage = ReadyImageCacheItem;

export function resolveCandidateAxes(
  device: RandomRequestDevice,
  brightness: RandomBrightness | null,
  userAgent: string
) {
  const detectedDevice = device === "auto"
    ? detectDeviceFromUserAgent(userAgent)
    : null;
  let deviceCandidates: Device[];
  if (device === "pc" || device === "mb") {
    deviceCandidates = [device];
  } else if (device === "auto" && detectedDevice) {
    deviceCandidates = [detectedDevice];
  } else {
    deviceCandidates = [...randomDevices];
  }
  const brightnessCandidates = brightness
    && isRandomBrightness(brightness)
    ? [brightness]
    : [...randomBrightnesses];
  return {
    deviceCandidates,
    brightnessCandidates,
    device,
    brightness
  };
}
