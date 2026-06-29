// Automatic light/dark classification.
//
// Derived from scripts/classify.py's perceptual score (a weighted blend of CIELAB
// L* percentiles, nudged by the share of very-dark / very-bright pixels), but tuned
// for this app: the original's hard-dark + "rescue" rules existed to flag borderline
// cases for human review, which has no place here — we need one direct verdict. On a
// 407-image labeled set (the random-img/{mb,pc}-{dark,light} folders) those rules
// actually cost ~1.7pp; dropping them and recalibrating the single threshold lifts
// accuracy from 95.3% to 97.0% (5-fold CV ≈ 96.8%). Pixel decoding is done by sharp;
// everything below is pure arithmetic on the histogram, so it's unit-testable.
import sharp from "sharp";
import type { Brightness } from "@imageshow/shared";

const BRIGHTNESS_THUMBNAIL = 1024; // long-edge cap before analysis
// score < threshold => dark. Empirically tuned on the labeled set above: the accuracy
// curve plateaus at 115–116 (97.0%); 116 gives the most balanced dark/light recall.
// Callers classify the 512px webp thumbnail rather than the original (see
// imageBrightnessHistogram); re-validated on the same 407-image set, that pipeline
// tracks the original to within one image (96.8%, disagreeing on 1/407), so 116 still
// holds and stays the balanced choice — no re-tune needed.
const DARK_THRESHOLD = 116.0;
const DARK_PIXEL_MAX = 82; // L* < this counts as a dark pixel
const BRIGHT_PIXEL_MIN = 180; // L* >= this counts as a bright pixel
const SCORE_WEIGHT_P50 = 0.3;
const SCORE_WEIGHT_MEAN = 0.3;
const SCORE_WEIGHT_P75 = 0.4;
const DARK_RATIO_PENALTY_START = 0.5;
const DARK_RATIO_PENALTY_SCALE = 18.0;
const BRIGHT_RATIO_BONUS_START = 0.18;
const BRIGHT_RATIO_BONUS_SCALE = 10.0;

// sRGB gamma → linear, precomputed for each 8-bit value (the hot per-pixel step).
const LINEAR_LUT = (() => {
  const lut = new Float64Array(256);
  for (let c = 0; c < 256; c += 1) {
    const v = c / 255;
    lut[c] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

// CIELAB L* of an sRGB pixel, scaled to 0–255 like PIL's "LAB" mode (L* is 0–100,
// PIL stores it ×2.55). L* depends only on relative luminance Y, so a, b are skipped.
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

// Perceptual lightness score of a 256-bin L* histogram. Higher = lighter. Blends the
// median / mean / 75th-percentile L*, then penalizes a heavily dark image and rewards
// a notably bright one. Kept a separate pure function so the score (not just the verdict)
// can be reasoned about independently.
function brightnessScore(hist: number[]): number {
  let total = 0;
  let weighted = 0;
  let darkCount = 0;
  let brightCount = 0;
  for (let value = 0; value < 256; value += 1) {
    const count = hist[value];
    total += count;
    weighted += value * count;
    if (value < DARK_PIXEL_MAX) darkCount += count;
    if (value >= BRIGHT_PIXEL_MIN) brightCount += count;
  }
  total = total || 1;
  const mean = weighted / total;
  const p50 = percentileFromHistogram(hist, total, 0.5);
  const p75 = percentileFromHistogram(hist, total, 0.75);
  const darkRatio = darkCount / total;
  const brightRatio = brightCount / total;

  let score = SCORE_WEIGHT_P50 * p50 + SCORE_WEIGHT_MEAN * mean + SCORE_WEIGHT_P75 * p75;
  score -= DARK_RATIO_PENALTY_SCALE * Math.max(0, darkRatio - DARK_RATIO_PENALTY_START);
  score += BRIGHT_RATIO_BONUS_SCALE * Math.max(0, brightRatio - BRIGHT_RATIO_BONUS_START);
  return score;
}

// Direct light/dark verdict over a 256-bin L* histogram — one definitive answer,
// no "uncertain" state.
function classifyBrightnessHistogram(hist: number[]): "dark" | "light" {
  return brightnessScore(hist) < DARK_THRESHOLD ? "dark" : "light";
}

// Decodes an image (Buffer or file path) into its 256-bin CIELAB L* histogram.
// Alpha is composited over white first (matching PIL) so transparent regions aren't
// read as black; analysis runs on a ≤1024px copy to bound the work. Callers pass the
// stored 512px thumbnail where possible, so in practice this just decodes that small
// webp (the ≤1024 cap then no-ops). Split out from the classifier so the (expensive)
// decode and the (pure) decision can be tested and evaluated independently.
async function imageBrightnessHistogram(input: Buffer | string): Promise<number[]> {
  const { data, info } = await sharp(input)
    .resize({ width: BRIGHTNESS_THUMBNAIL, height: BRIGHTNESS_THUMBNAIL, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const hist = new Array(256).fill(0);
  for (let i = 0; i + channels - 1 < data.length; i += channels) {
    const r = data[i];
    const g = channels >= 3 ? data[i + 1] : r;
    const b = channels >= 3 ? data[i + 2] : r;
    hist[labL(r, g, b)] += 1;
  }
  return hist;
}

// Decodes an image and returns its light/dark classification.
export async function detectBrightness(input: Buffer | string): Promise<Exclude<Brightness, "none">> {
  return classifyBrightnessHistogram(await imageBrightnessHistogram(input));
}
