import type { RandomMode } from "./types.js";

export function buildRandomUrl(input: { origin?: string; device: string; brightness: string; theme: string; mode: RandomMode }) {
  const params: string[] = [];
  if (input.device) params.push(`d=${encodeRandomParam(input.device)}`);
  if (input.brightness !== "random") params.push(`b=${encodeRandomParam(input.brightness)}`);
  const themes = input.theme.split(",").map((theme) => theme.trim().toLowerCase()).filter(Boolean);
  if (themes.length) params.push(`t=${encodeRandomParam(themes.join(","))}`);
  if (input.mode) params.push(`m=${encodeRandomParam(input.mode)}`);
  return `${input.origin ?? window.location.origin}/random${params.length ? `?${params.join("&")}` : ""}`;
}

export function encodeRandomParam(value: string) {
  return encodeURIComponent(value).replace(/%21/g, "!").replace(/%2C/gi, ",");
}
