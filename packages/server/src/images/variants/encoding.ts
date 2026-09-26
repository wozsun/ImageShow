import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import {
  imageVariants,
  parsePreparationProfile,
  type ImageVariant,
  type PreparationProfile,
  type PreparedVariantFacts,
  type VariantSettings
} from "@imageshow/shared/browser";
import { digestLocalFile, syncFile } from "../../storage/drivers/local-publication.ts";

const pixelLimit = 268402689;
const memoryLimit = 128 * 1024 * 1024;
const diskLimit = 256 * 1024 * 1024;
type Encoded = { data: Buffer; width: number; height: number };
type CacheEntry = {
  data?: Buffer;
  path?: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
};

export function profileFingerprint(profile: PreparationProfile) {
  return createHash("sha256").update(JSON.stringify(parsePreparationProfile(profile))).digest("hex");
}

export function variantFingerprint(profile: PreparationProfile, variant: ImageVariant) {
  return createHash("sha256").update(JSON.stringify({
    variant, settings: parsePreparationProfile(profile)[variant], step: profile.quality_step,
    format: "webp", frame: 0, rotate: true, fit: "inside", enlarge: false,
    encoder: sharp.versions
  })).digest("hex");
}

function qualityGrid(settings: VariantSettings, step: number) {
  const result = [settings.quality];
  while (result.at(-1)! > settings.min_quality) result.push(Math.max(settings.min_quality, result.at(-1)! - step));
  return result;
}

class EncodingCache {
  private entries = new Map<string, CacheEntry>();
  private memory = 0;
  private disk = 0;
  private readonly directory: string;
  constructor(directory: string) { this.directory = directory; }

  async get(key: string): Promise<Encoded | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (entry.data) return { data: entry.data, width: entry.width, height: entry.height };
    try {
      const data = await readFile(entry.path!);
      if (data.length !== entry.bytes || createHash("sha256").update(data).digest("hex") !== entry.sha256) {
        await this.drop(key);
        return;
      }
      return { data, width: entry.width, height: entry.height };
    } catch { await this.drop(key); return; }
  }

  private async drop(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.data) this.memory -= entry.bytes;
    if (entry.path) { this.disk -= entry.bytes; await rm(entry.path, { force: true }); }
    this.entries.delete(key);
  }

  async put(key: string, encoded: Encoded) {
    if (encoded.data.length > memoryLimit) return;
    await this.drop(key);
    while (this.memory + encoded.data.length > memoryLimit) {
      const oldest = [...this.entries].find(([, entry]) => entry.data);
      if (!oldest) break;
      const [oldKey, entry] = oldest;
      while (this.disk + entry.bytes > diskLimit) {
        const diskKey = [...this.entries].find(([, value]) => value.path)?.[0];
        if (!diskKey) break;
        await this.drop(diskKey);
      }
      await mkdir(this.directory, { recursive: true });
      entry.path = join(this.directory, oldKey);
      await writeFile(entry.path, entry.data!, { flag: "wx" });
      this.memory -= entry.bytes;
      this.disk += entry.bytes;
      delete entry.data;
    }
    this.entries.set(key, {
      ...encoded, bytes: encoded.data.length,
      sha256: createHash("sha256").update(encoded.data).digest("hex")
    });
    this.memory += encoded.data.length;
  }

  async close() {
    for (const key of this.entries.keys()) await this.drop(key);
    await rm(this.directory, { recursive: true, force: true });
  }
}

async function imageMetadata(path: string) {
  const metadata = await sharp(path, { limitInputPixels: pixelLimit, failOn: "warning" }).metadata();
  const height = metadata.pageHeight ?? metadata.height;
  const rotated = (metadata.orientation ?? 1) >= 5;
  return {
    metadata,
    width: rotated ? height : metadata.width,
    height: rotated ? metadata.width : height
  };
}

/** Decode every frame into a streaming sink; never retain a multi-frame raw buffer. */
export async function verifyVariantFile(path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const { metadata, width, height } = await imageMetadata(path);
  if (metadata.format !== "webp" || width <= 0 || height <= 0 || Math.max(width, height) > 16383) {
    throw new Error("产物不是合法尺寸的 WebP");
  }
  const frames = metadata.pages ?? 1;
  if (!Number.isSafeInteger(frames) || frames * width * height > pixelLimit * 4) {
    throw new Error("动画完整解码超过核验像素预算");
  }
  for (let page = 0; page < frames; page += 1) {
    signal.throwIfAborted();
    await pipeline(
      sharp(path, { page, pages: 1, limitInputPixels: pixelLimit, failOn: "warning" }).rotate().raw(),
      new Writable({ write(_chunk, _encoding, done) { done(); } }),
      { signal }
    );
  }
  return { ...await digestLocalFile(path, signal), width, height };
}

export async function createVariantEncoder(
  input: string,
  profile: PreparationProfile,
  cacheDirectory: string,
  maxSourceLongEdge: number,
  signal: AbortSignal
) {
  const source = await imageMetadata(input);
  const sourceSize = (await stat(input)).size;
  const supported = ["jpeg", "png", "webp", "gif"].includes(source.metadata.format)
    || (source.metadata.format === "heif" && source.metadata.compression === "av1");
  if (!supported || Math.max(source.width, source.height) > maxSourceLongEdge) throw new Error("原图类型或尺寸超出接入限制");
  const cache = new EncodingCache(cacheDirectory);
  const effectiveResize = (variant: ImageVariant) => Math.min(
    Math.max(source.width, source.height), profile[variant].max_long_edge
  );
  const equivalentLater = (variant: ImageVariant, quality: number) => imageVariants
    .slice(imageVariants.indexOf(variant) + 1)
    .some((next) => effectiveResize(next) === effectiveResize(variant)
      && profile[next].webp_effort === profile[variant].webp_effort
      && qualityGrid(profile[next], profile.quality_step).includes(quality));

  return {
    close: () => cache.close(),
    async encode(variant: ImageVariant, candidate: string): Promise<PreparedVariantFacts> {
      signal.throwIfAborted();
      const settings = profile[variant];
      const target = settings.max_size_kb * 1024;
      const passthrough = variant === "large" && source.metadata.format === "webp"
        && sourceSize < target && Math.max(source.width, source.height) <= settings.max_long_edge;
      let quality: number | null = null;
      if (passthrough) await copyFile(input, candidate, constants.COPYFILE_EXCL);
      else {
        const grid = qualityGrid(settings, profile.quality_step);
        const encode = async (q: number): Promise<Encoded> => {
          signal.throwIfAborted();
          // All other options and input are invariant for this image-local cache.
          const key = createHash("sha256").update(JSON.stringify({
            edge: effectiveResize(variant), q, effort: settings.webp_effort,
            frame: 0, rotation: "auto", fit: "inside", enlarge: false, format: "webp"
          })).digest("hex");
          const hit = await cache.get(key);
          if (hit) return hit;
          const { data, info } = await sharp(input, { page: 0, pages: 1, limitInputPixels: pixelLimit, failOn: "warning" })
            .rotate().resize({ width: effectiveResize(variant), height: effectiveResize(variant), fit: "inside", withoutEnlargement: true })
            .webp({ quality: q, effort: settings.webp_effort }).toBuffer({ resolveWithObject: true });
          signal.throwIfAborted();
          const result = { data, width: info.width, height: info.height };
          if (equivalentLater(variant, q)) await cache.put(key, result);
          return result;
        };
        let index = 0;
        let previousOver = -1;
        let chosen: Encoded;
        while (true) {
          chosen = await encode(grid[index]!);
          if (chosen.data.length <= target) {
            for (let back = index - 1; back > previousOver; back -= 1) {
              const attempt = await encode(grid[back]!);
              if (attempt.data.length > target) break;
              chosen = attempt;
              index = back;
            }
            break;
          }
          if (index === grid.length - 1) break;
          previousOver = index;
          index = Math.min(grid.length - 1, index + Math.min(3, Math.max(1, Math.floor(chosen.data.length / target))));
        }
        quality = grid[index]!;
        const handle = await open(candidate, "wx");
        try { await handle.writeFile(chosen.data); await handle.sync(); } finally { await handle.close(); }
      }
      await syncFile(candidate);
      const facts = await verifyVariantFile(candidate, signal);
      return {
        ...facts, quality, effort: passthrough ? null : settings.webp_effort,
        passthrough, over_target: facts.bytes > target
      };
    }
  };
}
