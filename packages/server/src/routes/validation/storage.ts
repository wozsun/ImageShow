import { z } from "zod";
import {
  slugMaxLength,
  slugPattern
} from "@imageshow/shared/browser";
import type {
  StorageBackendCreateInput,
  StorageBackendTestInput,
  StorageBackendUpdateInput
} from "../../storage/backends/config.ts";
import {
  s3SettingsPatchSchema,
  s3SettingsSchema
} from "../../storage/backends/config.ts";
import { requestSlugInput } from "./primitives.ts";

export const storageSlugInput = requestSlugInput;

// Backend create/test historically used Zod's default slug issue messages,
// while migration, reorder and path parameters used the shared request slug
// messages. Keep those HTTP error contracts distinct.
const storageBackendSlugInput = z.string().trim().toLowerCase().min(1)
  .max(slugMaxLength).regex(slugPattern);

export const storageSlugListInput = z.strictObject({
  slugs: z.array(storageSlugInput).min(1).max(2000)
    .transform((slugs) => [...new Set(slugs)])
});

export const storageBackendMigrationInput = z.strictObject({
  source: storageSlugInput,
  target: storageSlugInput
}).refine(
  ({ source, target }) => source !== target,
  {
    path: ["target"],
    message: "目标存储后端不能与源后端相同"
  }
);

const storageDisplayInput = z.string().trim().max(64);
const nonEmptySettingsObject = z.record(z.string(), z.unknown()).refine(
  (value) => Object.keys(value).length > 0,
  "远端存储配置至少需要提供一个字段"
);
const s3SettingsUpdateSchema = nonEmptySettingsObject.pipe(
  s3SettingsPatchSchema
);

export const storageBackendCreateInput = z.strictObject({
  slug: storageBackendSlugInput,
  display_name: storageDisplayInput.optional().default(""),
  s3: s3SettingsSchema.optional().prefault({})
}) satisfies z.ZodType<StorageBackendCreateInput>;

export const storageBackendUpdateInput = z.strictObject({
  display_name: storageDisplayInput.optional(),
  enabled: z.boolean().optional(),
  s3: s3SettingsUpdateSchema.optional()
}).refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  "存储后端更新至少需要提供一个字段"
) satisfies z.ZodType<StorageBackendUpdateInput>;

export const storageBackendTestInput = z.strictObject({
  slug: storageBackendSlugInput.optional(),
  s3: s3SettingsPatchSchema.optional()
}).refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  "存储测试至少需要提供一个配置字段"
) satisfies z.ZodType<StorageBackendTestInput>;
