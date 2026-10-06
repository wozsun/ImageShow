import sharp from "sharp";
import type { Brightness } from "@imageshow/shared/browser";

const DARK_THRESHOLD = 113.08;
const DARK_PIXEL_BELOW = 104;
const BRIGHT_PIXEL_MIN = 237;
const SCORE_WEIGHT_MEAN = 0.7173;
const SCORE_WEIGHT_P75 = 0.2827;
const BRIGHT_RATIO_BONUS_START = 0.099;
const BRIGHT_RATIO_BONUS_SCALE = 42.59;
const HARD_DARK_P50_BELOW = 79;
const HARD_DARK_RATIO_MIN = 0.5798;

const LINEAR_LUT = (() => {
  const lut = new Float64Array(256);
  for (let c = 0; c < 256; c += 1) {
    const v = c / 255;
    lut[c] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

function labL(r: number, g: number, b: number): number {
  const y = 0.2126 * LINEAR_LUT[r] + 0.7152 * LINEAR_LUT[g] + 0.0722 * LINEAR_LUT[b];
  const fy = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
  const l = (116 * fy - 16) * 2.55;
  return l <= 0 ? 0 : l >= 255 ? 255 : Math.round(l);
}

function percentileFromHistogram(hist: number[], total: number, p: number): number {
  const threshold = total * p;
  let cumulative = 0;
  for (let value = 0; value < 256; value += 1) {
    cumulative += hist[value];
    if (cumulative >= threshold) return value;
  }
  return 255;
}

function brightnessMetrics(hist: number[]) {
  let total = 0;
  let weighted = 0;
  let darkCount = 0;
  let brightCount = 0;
  for (let value = 0; value < 256; value += 1) {
    const count = hist[value];
    total += count;
    weighted += value * count;
    if (value < DARK_PIXEL_BELOW) darkCount += count;
    if (value >= BRIGHT_PIXEL_MIN) brightCount += count;
  }
  const mean = weighted / total;
  const p50 = percentileFromHistogram(hist, total, 0.5);
  const p75 = percentileFromHistogram(hist, total, 0.75);
  const darkRatio = darkCount / total;
  const brightRatio = brightCount / total;

  let score = SCORE_WEIGHT_MEAN * mean + SCORE_WEIGHT_P75 * p75;
  score += BRIGHT_RATIO_BONUS_SCALE * Math.max(0, brightRatio - BRIGHT_RATIO_BONUS_START);
  return { score, p50, darkRatio };
}

function classifyBrightnessHistogram(hist: number[]): "dark" | "light" {
  const { score, p50, darkRatio } = brightnessMetrics(hist);
  if (p50 < HARD_DARK_P50_BELOW && darkRatio > HARD_DARK_RATIO_MIN) return "dark";
  return score < DARK_THRESHOLD ? "dark" : "light";
}

/**
 * Analyses the stored small variant as published: transparency is composited on
 * white and the sRGB conversion always yields three channels, so every pixel
 * contributes and the histogram is never empty.
 */
async function imageBrightnessHistogram(smallVariant: Buffer): Promise<number[]> {
  const { data, info } = await sharp(smallVariant)
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hist = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += info.channels) {
    hist[labL(data[i], data[i + 1], data[i + 2])] += 1;
  }
  return hist;
}

/** Classifies the small variant that ingestion and the classification editor both read. */
export async function detectBrightness(smallVariant: Buffer): Promise<Brightness> {
  return classifyBrightnessHistogram(await imageBrightnessHistogram(smallVariant));
}
