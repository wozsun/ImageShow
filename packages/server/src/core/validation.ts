import { z } from "zod";
import { adminImagePageLimit, appConfig, categoryKey, slugPattern, type Brightness, type Device } from "@imageshow/shared";
import { ApiError } from "./http.js";

function httpUrlField(message: string) {
  return z.string().trim().max(2048).default("")
    .transform((value) => {
      if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
      return `https://${value}`;
    })
    .refine((value) => {
      if (value === "") return true;
      try {
        const parsed = new URL(value);
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
          && /^[a-z0-9.-]+$/.test(parsed.hostname);
      } catch {
        return false;
      }
    }, message);
}

const metadataInput = z.object({
  device: z.enum(appConfig.devices),
  brightness: z.enum(appConfig.brightness),
  theme: z.string().trim().toLowerCase().min(1).max(appConfig.themeMaxLength).regex(slugPattern).default("none"),
  author: z.string().trim().toLowerCase().max(32)
    .refine((value) => value === "" || slugPattern.test(value), "author must be a lowercase slug")
    .default(""),
  title: z.string().trim().max(200).default(""),
  description: z.string().trim().max(2000).default(""),
  source: z.string().trim().max(2048).default(""),
  original: httpUrlField("原图 URL 需为有效的 http(s) 链接")
});

export const metadataUpdateInput = metadataInput.partial().extend({
  brightness: z.enum(["dark", "light", "auto"]).optional()
});

export const md5Input = z.object({
  md5: z.string().trim().toLowerCase().regex(/^[a-f0-9]{32}$/)
});

const slugInput = z.string().trim().toLowerCase()
  .min(1, "标识 slug 不能为空")
  .max(32, "标识 slug 最长 32 个字符")
  .regex(slugPattern, "标识 slug 只能包含小写字母、数字、连字符，且不能以连字符开头或结尾");
const displayNameInput = z.string().trim().max(64, "显示名最长 64 个字符");

export const tagSlugInput = slugInput;
export const tagCreateInput = z.object({ slug: tagSlugInput, display_name: displayNameInput.optional().default("") });
export const tagDisplayUpdateInput = z.object({ display_name: displayNameInput.default("") });

export const imageTagsInput = z.object({
  tags: z.array(tagSlugInput).max(50).optional().transform((tags) => [...new Set(tags ?? [])])
});

export const themeSlugInput = slugInput;
const themeDisplayInput = displayNameInput;

export const slugListInput = z.object({
  slugs: z.array(slugInput).min(1).max(2000).transform((slugs) => [...new Set(slugs)])
});
export const themeCreateInput = z.object({ slug: themeSlugInput, display_name: themeDisplayInput.optional().default("") });
export const themeDisplayUpdateInput = z.object({ display_name: themeDisplayInput.default("") });

export const authorSlugInput = slugInput;
const authorLinkInput = httpUrlField("作者主页链接需为有效的 http(s) 链接");
export const authorCreateInput = z.object({ slug: authorSlugInput, display_name: displayNameInput.optional().default(""), link: authorLinkInput });
export const authorMetaUpdateInput = z.object({ display_name: displayNameInput.default(""), link: authorLinkInput });

export const uuidInput = z.string().uuid();

export const adminUsernameInput = z.string().trim().toLowerCase()
  .min(1, "用户名不能为空")
  .max(32, "用户名最长 32 个字符")
  .regex(slugPattern, "用户名只能包含小写字母、数字、连字符，且不能以连字符开头或结尾");
const adminPasswordInput = z.string().min(8).max(128)
  .regex(/^(?=.*[A-Za-z])(?=.*\d).+$/, "密码至少 8 位，且需同时包含字母和数字");
export const userCreateInput = z.object({ username: adminUsernameInput, password: adminPasswordInput });
export const userPasswordInput = z.object({ password: adminPasswordInput });

export const passwordChangeInput = z.object({
  current_password: z.string().min(1).max(128),
  new_password: adminPasswordInput
});

export const imageIdsInput = z.object({
  ids: z.array(uuidInput).min(1).max(200).transform((ids) => [...new Set(ids)])
});

export const storageSlugInput = slugInput;

export const batchMigrateStorageInput = z.object({
  ids: z.array(uuidInput).min(1).max(200).transform((ids) => [...new Set(ids)]),
  target: storageSlugInput
});

export const uploadCreateInput = metadataInput.extend({

  brightness: z.enum(["dark", "light", "auto"]).default("auto"),

  size: z.number().int().positive(),
  session_id: z.string().uuid(),
  idempotency_key: z.string().uuid(),
  tags: z.array(tagSlugInput).max(50).optional().transform((tags) => [...new Set(tags ?? [])]),
  storage_slug: storageSlugInput.optional()
});

export const linkPrepareInput = z.object({
  url: z.string().trim().url().max(2048),
  staging_id: z.string().uuid(),
  storage_slug: storageSlugInput.optional().default("local")
});

export const linkCommitInput = metadataInput.extend({

  brightness: z.enum(["dark", "light", "auto"]).default("auto"),
  staging_id: z.string().uuid(),
  tags: z.array(tagSlugInput).max(50).optional().transform((tags) => [...new Set(tags ?? [])]),
});

export const linkDownloadPrepareInput = z.object({
  url: z.string().trim().url().max(2048),
  storage_slug: storageSlugInput.optional().default("local"),
  session_id: z.string().uuid(),
  idempotency_key: z.string().uuid()
});

export const linkDownloadCommitInput = metadataInput.extend({
  brightness: z.enum(["dark", "light", "auto"]).default("auto"),
  staging_id: z.string().uuid(),
  tags: z.array(tagSlugInput).max(50).optional().transform((tags) => [...new Set(tags ?? [])])
});

const imageListBase = z.object({
  status: z.enum(["ready", "deleted"]).default("ready"),
  d: z.enum(appConfig.devices).optional(),
  b: z.enum(appConfig.brightness).optional(),
  t: z.string().trim().toLowerCase().max(1024).optional(),

  tag: z.string().trim().toLowerCase().max(1024).optional(),

  a: z.string().trim().toLowerCase().max(1024).optional(),
  cursor: z.string().trim().min(1).max(512).optional()
});

export const listQuery = imageListBase.extend({

  status: z.literal("ready").default("ready"),
  limit: z.coerce.number().int().positive().max(appConfig.pagination.maxLimit).optional(),

  shuffle: z.enum(["1", "true"]).optional().transform(Boolean)
});

export const adminImageListQuery = imageListBase.extend({
  limit: z.coerce.number().int().positive().max(appConfig.pagination.maxLimit).default(adminImagePageLimit)
});

export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {

    const flat = result.error.flatten();
    const messages = [...flat.formErrors, ...Object.values(flat.fieldErrors).flatMap((errs) => errs ?? [])];
    const detail = [...new Set(messages)].join("；") || "请求参数有误";
    throw new ApiError(400, "validation_error", detail, flat);
  }
  return result.data;
}

export function normalizedCategory(input: { device: Device; brightness: Brightness; theme: string }) {
  return categoryKey(input.device, input.brightness, input.theme || "none");
}
