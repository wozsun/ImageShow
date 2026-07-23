import { z } from "zod";
import type { Brightness, Device } from "@imageshow/shared";

export type ImageLookupItem = {
  object_key: string;
  thumb_key: string;
  ext: string;
  storage_slug: string;
  status: "ready";
};

export type ImageLookupByIdItem = {
  id: string;
  object_key: string;
  original: string;
  ext: string;
  storage_slug: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  status: string;
  description: string;
  source: string;
};

const imageExtensionSchema = z.enum(["jpg", "png", "webp", "gif", "avif"]);

const imageLookupSchema: z.ZodType<ImageLookupItem> = z.strictObject({
  object_key: z.string().min(1),
  thumb_key: z.string().min(1),
  ext: imageExtensionSchema,
  storage_slug: z.string().min(1),
  status: z.literal("ready")
});

const imageLookupByIdSchema: z.ZodType<ImageLookupByIdItem> = z.strictObject({
  id: z.string().min(1),
  object_key: z.string().min(1),
  original: z.string(),
  ext: imageExtensionSchema,
  storage_slug: z.string().min(1),
  device: z.enum(["pc", "mb"]),
  brightness: z.enum(["dark", "light"]),
  theme: z.string(),
  status: z.enum(["ready", "deleted"]),
  description: z.string(),
  source: z.string()
});

function parseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseImageLookup(raw: string) {
  return parseJson(raw, imageLookupSchema);
}

export function parseImageLookupById(raw: string) {
  return parseJson(raw, imageLookupByIdSchema);
}
