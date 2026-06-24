import { z } from "zod";
import { adminImagePageLimit, appConfig, categoryKey, type Brightness, type Device } from "@imageshow/shared";
import { ApiError } from "./http.js";

export const metadataInput = z.object({
  device: z.enum(appConfig.devices).default("none"),
  brightness: z.enum(appConfig.brightness).default("none"),
  theme: z.string().trim().toLowerCase().min(1).max(appConfig.themeMaxLength).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).default("none"),
  title: z.string().trim().max(200).default(""),
  description: z.string().trim().max(2000).default(""),
  source: z.string().trim().max(2048).default(""),
  original: z.string().trim().max(2048).default("").refine((value) => value === "" || /^https?:\/\//i.test(value), "original must be http(s)")
});

export const md5Input = z.object({
  md5: z.string().trim().toLowerCase().regex(/^[a-f0-9]{32}$/)
});

export const uuidInput = z.string().uuid();

export const imageIdsInput = z.object({
  ids: z.array(uuidInput).min(1).max(200).transform((ids) => [...new Set(ids)])
});

export const storageBackendInput = z.enum(["local", "s3"]);

export const migrateStorageInput = z.object({ target: storageBackendInput });

export const batchMigrateStorageInput = z.object({
  ids: z.array(uuidInput).min(1).max(200).transform((ids) => [...new Set(ids)]),
  target: storageBackendInput
});

export const uploadCreateInput = metadataInput.extend({
  original_filename: z.string().trim().min(1).max(255),
  client_ext: z.enum(["jpg", "jpeg", "png", "webp", "gif", "avif"]).transform((value) => value === "jpeg" ? "jpg" : value),
  size: z.number().int().positive(),
  md5: md5Input.shape.md5,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  idempotency_key: z.string().uuid(),
  storage_backend: storageBackendInput.optional()
});

// Shared shape for the cursor-paginated image lists. Both the public gallery and
// the admin list page through (created_at, id) via an opaque `cursor`.
const imageListBase = z.object({
  status: z.enum(["ready", "deleted"]).default("ready"),
  d: z.enum(appConfig.devices).optional(),
  b: z.enum(appConfig.brightness).optional(),
  t: z.string().trim().toLowerCase().max(1024).optional(),
  unset: z.enum(["1", "true"]).optional().transform(Boolean),
  cursor: z.string().trim().min(1).max(512).optional()
});

export const listQuery = imageListBase.extend({
  limit: z.coerce.number().int().positive().max(appConfig.pagination.maxLimit).optional()
});

export const adminImageListQuery = imageListBase.extend({
  limit: z.coerce.number().int().positive().max(appConfig.pagination.maxLimit).default(adminImagePageLimit)
});

export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, "validation_error", "Validation failed", result.error.flatten());
  return result.data;
}

export function normalizedCategory(input: { device: Device; brightness: Brightness; theme: string }) {
  return categoryKey(input.device, input.brightness, input.theme || "none");
}
