import type { ReadyImageCacheItem } from "../images/ready-cache/model.ts";
import {
  isRandomBrightness,
  randomBrightnesses,
  randomDevices
} from "./query.ts";

export type SelectedReadyImage = ReadyImageCacheItem;

function inferDevice(userAgent: string) {
  if (!userAgent) return "r";
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(userAgent)) return "mb";
  if (/Windows|Macintosh|Linux x86_64|X11/i.test(userAgent)) return "pc";
  return "r";
}

export function resolveCandidateAxes(
  requestedDevice: string | null,
  requestedBrightness: string | null,
  userAgent: string
) {
  const device = requestedDevice || inferDevice(userAgent);
  const deviceCandidates = device === "r"
    ? [...randomDevices]
    : [device as "pc" | "mb"];
  const brightnessCandidates = requestedBrightness
    && isRandomBrightness(requestedBrightness)
    ? [requestedBrightness]
    : [...randomBrightnesses];
  return {
    deviceCandidates,
    brightnessCandidates,
    requestedDevice,
    requestedBrightness
  };
}
