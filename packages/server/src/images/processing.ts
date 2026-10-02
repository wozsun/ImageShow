import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { imageVariants, type ImageVariant, type NormalizeProfile, type PreparedVariantFacts } from "@imageshow/shared/browser";
import { getIngestionMaxLongEdge } from "../config/app-settings.ts";
import { withVariantScratch } from "./variants/scratch.ts";
import { createVariantEncoder } from "./variants/encoding.ts";

export function configureSharpRuntime() {
  sharp.cache({ files: 0 });
  sharp.concurrency(1);
}

export type PreparedStoredImage = {
  sourceSize: number;
  sourceWidth: number;
  sourceHeight: number;
  variants: Record<ImageVariant, { data: Buffer; facts: PreparedVariantFacts }>;
};

/** Every output starts from the same source and shares only equivalent encoded results. */
export async function transcodeStoredImage(
  path: string,
  settings: NormalizeProfile,
  signal: AbortSignal
): Promise<PreparedStoredImage> {
  signal.throwIfAborted();
  const metadata = await sharp(path).metadata();
  const sourceHeight = metadata.pageHeight ?? metadata.height;
  const rotated = (metadata.orientation ?? 1) >= 5;
  return withVariantScratch(async (directory) => {
    let encoder: Awaited<ReturnType<typeof createVariantEncoder>> | undefined;
    try {
      encoder = await createVariantEncoder(path, settings, join(directory, "cache"), getIngestionMaxLongEdge(), signal);
      const variants = {} as PreparedStoredImage["variants"];
      for (const variant of imageVariants) {
        const target = join(directory, `${variant}.webp`);
        const facts = await encoder.encode(variant, target);
        signal.throwIfAborted();
        variants[variant] = { facts, data: await readFile(target) };
      }
      return {
        sourceSize: (await stat(path)).size,
        sourceWidth: rotated ? sourceHeight : metadata.width,
        sourceHeight: rotated ? metadata.width : sourceHeight,
        variants
      };
    } finally {
      await encoder?.close();
    }
  });
}
