import { z } from "zod";
import { adminImagePageLimit, appConfig, slugPattern } from "@imageshow/shared";
import { adminPasswordInput, adminUsernameInput } from "../users/credentials.ts";
import { ApiError } from "./http.ts";
import { isHttpsUrl } from "./url-validation.ts";

const externalImageRejectedMessage = "外部图片请求未通过安全校验";

function httpsUrlField(message: string) {
  return urlBase(message).default("");
}

function optionalHttpsUrlField(message: string) {
  return urlBase(message).optional();
}

function httpsDomainUrlField(message: string) {
  return httpsUrlField(message).refine((value) => !value || isHttpsUrl(value, { requireDomain: true }), message);
}

function optionalHttpsDomainUrlField(message: string) {
  return optionalHttpsUrlField(message).refine((value) => !value || isHttpsUrl(value, { requireDomain: true }), message);
}

function urlBase(message: string) {
  return z.string().trim().max(2048)
    .transform((value) => {
      if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
      return `https://${value}`;
    })
    .refine((value) => {
      if (value === "") return true;
      return isHttpsUrl(value);
    }, message);
}

const classificationDevices = [...appConfig.devices, "auto"] as const;

const metadataInput = z.object({
  device: z.enum(classificationDevices),
  brightness: z.enum(appConfig.brightness),
  theme: z.string().trim().toLowerCase().min(1).max(appConfig.themeMaxLength).regex(slugPattern).default("none"),
  author: z.string().trim().toLowerCase().max(32)
    .refine((value) => value === "" || slugPattern.test(value), "author must be a lowercase slug")
    .default(""),
  title: z.string().trim().max(200).default(""),
  description: z.string().trim().max(2000).default(""),
  source: httpsUrlField("来源页面链接需为有效的 HTTPS 链接"),
  original: httpsDomainUrlField(externalImageRejectedMessage)
});

export const metadataUpdateInput = z.object({
  device: z.enum(classificationDevices).optional(),
  brightness: z.enum(["dark", "light", "auto"]).optional(),
  theme: z.string().trim().toLowerCase().min(1).max(appConfig.themeMaxLength).regex(slugPattern).optional(),
  author: z.string().trim().toLowerCase().max(32)
    .refine((value) => value === "" || slugPattern.test(value), "author must be a lowercase slug")
    .optional(),
  title: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  source: optionalHttpsUrlField("来源页面链接需为有效的 HTTPS 链接"),
  original: optionalHttpsDomainUrlField(externalImageRejectedMessage)
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
const authorLinkInput = httpsUrlField("作者主页链接需为有效的 HTTPS 链接");
export const authorCreateInput = z.object({ slug: authorSlugInput, display_name: displayNameInput.optional().default(""), link: authorLinkInput });
export const authorMetaUpdateInput = z.object({ display_name: displayNameInput.default(""), link: authorLinkInput });

export const uuidInput = z.string().uuid();

export { adminUsernameInput } from "../users/credentials.ts";
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

export const importCreateInput = metadataInput.extend({
  mode: z.enum(["upload", "download", "proxy"]),
  brightness: z.enum(["dark", "light", "auto"]).default("auto"),
  source_url: optionalHttpsDomainUrlField(externalImageRejectedMessage),
  image_time: z.string().trim().min(1).max(64).optional(),
  manifest_position: z.number().int().min(0).max(0xfff).optional(),
  size: z.number().int().positive().optional(),
  idempotency_key: z.string().uuid(),
  tags: z.array(tagSlugInput).max(50).optional().transform((tags) => [...new Set(tags ?? [])]),
  storage_slug: storageSlugInput.optional()
}).superRefine((value, ctx) => {
  if (value.mode === "upload" && !value.size) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["size"], message: "上传模式需要文件大小" });
  }
  if (value.mode !== "upload" && !value.source_url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source_url"], message: "链接导入模式需要图片链接" });
  }
});

export const importCommitInput = metadataInput.extend({
  brightness: z.enum(["dark", "light", "auto"]).default("auto"),
  tags: z.array(tagSlugInput).max(50).optional().transform((tags) => [...new Set(tags ?? [])])
});

export const jsonlManifestInput = z.object({
  content: z.string().min(1).max(appConfig.imports.jsonlManifestMaxBytes)
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= appConfig.imports.jsonlManifestMaxBytes,
      "JSONL 清单内容过大"
    )
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
