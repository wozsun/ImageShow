import { z } from "zod";
import { appConfig } from "@imageshow/shared";
import {
  adminImagePageLimit,
  adminPreferenceValueOptions,
  adminPreferencesMaxBytes,
  type BatchImageUpdateItemInputDto,
  importBatchHardLimit,
  importModes,
  slugMaxLength,
  slugPattern,
  vocabularyDisplayNameMaxLength
} from "@imageshow/shared/browser";
import { adminPasswordInput, adminUsernameInput } from "./credentials.ts";
import { ApiError } from "./api-error.ts";
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
  author: z.string().trim().toLowerCase().max(slugMaxLength)
    .refine((value) => value === "" || slugPattern.test(value), "author must be a lowercase slug")
    .default(""),
  title: z.string().trim().max(appConfig.imageMetadata.titleMaxLength).default(""),
  description: z.string().trim().max(appConfig.imageMetadata.descriptionMaxLength).default(""),
  source: httpsUrlField("来源页面链接需为有效的 HTTPS 链接"),
  original: httpsDomainUrlField(externalImageRejectedMessage)
});

export const metadataUpdateInput = z.object({
  device: z.enum(classificationDevices).optional(),
  brightness: z.enum(["dark", "light", "auto"]).optional(),
  theme: z.string().trim().toLowerCase().min(1).max(appConfig.themeMaxLength).regex(slugPattern).optional(),
  author: z.string().trim().toLowerCase().max(slugMaxLength)
    .refine((value) => value === "" || slugPattern.test(value), "author must be a lowercase slug")
    .optional(),
  title: z.string().trim().max(appConfig.imageMetadata.titleMaxLength).optional(),
  description: z.string().trim().max(appConfig.imageMetadata.descriptionMaxLength).optional(),
  source: optionalHttpsUrlField("来源页面链接需为有效的 HTTPS 链接"),
  original: optionalHttpsDomainUrlField(externalImageRejectedMessage)
});

const slugInput = z.string().trim().toLowerCase()
  .min(1, "标识 slug 不能为空")
  .max(slugMaxLength, `标识 slug 最长 ${slugMaxLength} 个字符`)
  .regex(slugPattern, "标识 slug 只能包含小写字母、数字、连字符，且不能以连字符开头或结尾");
const displayNameInput = z.string().trim().max(
  vocabularyDisplayNameMaxLength,
  `显示名最长 ${vocabularyDisplayNameMaxLength} 个字符`
);

export const tagSlugInput = slugInput;
export const tagCreateInput = z.object({ slug: tagSlugInput, display_name: displayNameInput.optional().default("") });
export const tagDisplayUpdateInput = z.object({ display_name: displayNameInput.default("") });

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

const batchImageTagsInput = z.array(tagSlugInput)
  // The public limit applies after normalization, so repeated spellings do not
  // consume the per-image tag allowance.
  .transform((tags) => [...new Set(tags)])
  .pipe(z.array(tagSlugInput).max(50));

const batchImageUpdateItemInput = metadataUpdateInput.extend({
  id: uuidInput,
  tags: batchImageTagsInput.optional(),
}).superRefine((value, ctx) => {
  const hasMetadataUpdate = Object.entries(value).some(([key, fieldValue]) =>
    key !== "id" && key !== "tags" && fieldValue !== undefined
  );
  if (!hasMetadataUpdate && value.tags === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "批量更新项必须包含 metadata 或 tags",
    });
  }
});

export type BatchImageUpdateItemInput = BatchImageUpdateItemInputDto;

export const batchImageUpdateInput = z.object({
  items: z.array(batchImageUpdateItemInput).min(1).max(200),
}).superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (let index = 0; index < value.items.length; index += 1) {
    const id = value.items[index].id.toLowerCase();
    if (ids.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index, "id"],
        message: "批量更新中的图片 ID 不能重复",
      });
    }
    ids.add(id);
  }
});

export const userCreateInput = z.object({ username: adminUsernameInput, password: adminPasswordInput });
export const userPasswordInput = z.object({ password: adminPasswordInput });

export const passwordChangeInput = z.object({
  current_password: z.string().min(1).max(128),
  new_password: adminPasswordInput
});

const adminPreferenceInputFields = {
  color_scheme: z.enum(adminPreferenceValueOptions.color_scheme).optional(),
  image_card_density: z.enum(adminPreferenceValueOptions.image_card_density).optional()
} satisfies Record<keyof typeof adminPreferenceValueOptions, z.ZodType>;

export const adminPreferencesInput = z.strictObject(adminPreferenceInputFields)
  .refine(
    (value) => Object.values(value).some((preference) => preference !== undefined),
    "至少需要提供一项管理端偏好"
  )
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= adminPreferencesMaxBytes,
    "管理端偏好过大"
  );

export const imageIdsInput = z.object({
  ids: z.array(uuidInput).min(1).max(200).transform((ids) => [...new Set(ids)])
});

export const storageSlugInput = slugInput;

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

export const batchMigrateStorageInput = z.object({
  ids: z.array(uuidInput).min(1).max(200).transform((ids) => [...new Set(ids)]),
  target: storageSlugInput
});

export const importCreateInput = metadataInput.extend({
  mode: z.enum(importModes),
  brightness: z.enum(["dark", "light", "auto"]).default("auto"),
  source_url: optionalHttpsDomainUrlField(externalImageRejectedMessage),
  image_time: z.string().trim().min(1).max(64).optional(),
  batch_time: z.string().trim().min(1).max(64).optional(),
  manifest_position: z.number().int().min(0).max(0xfff).optional(),
  size: z.number().int().positive().optional(),
  idempotency_key: z.string().uuid(),
  tags: z.array(tagSlugInput).max(50).optional().transform((tags) => [...new Set(tags ?? [])]),
  storage_slug: storageSlugInput.optional()
}).superRefine((value, ctx) => {
  if (value.mode === "upload" && !value.size) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["size"], message: "上传模式需要文件大小" });
  }
  if (value.mode === "download" && !value.source_url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source_url"], message: "链接导入模式需要图片链接" });
  }
});

const importCommitInput = metadataInput.extend({
  brightness: z.enum(["dark", "light", "auto"]).default("auto"),
  tags: z.array(tagSlugInput).max(50).optional().transform((tags) => [...new Set(tags ?? [])])
});

export const importBatchCommitInput = z.object({
  items: z.array(z.object({
    id: uuidInput.transform((id) => id.toLowerCase()),
    metadata: importCommitInput
  })).min(1).max(importBatchHardLimit)
}).superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (let index = 0; index < value.items.length; index += 1) {
    const id = value.items[index].id.toLowerCase();
    if (ids.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index, "id"],
        message: "导入提交批次不能包含重复会话"
      });
    }
    ids.add(id);
  }
});

export const jsonlManifestInput = z.object({
  content: z.string().min(1).max(appConfig.imports.jsonlManifestMaxBytes)
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= appConfig.imports.jsonlManifestMaxBytes,
      "JSONL 清单内容过大"
    )
});

export const weiboImportInput = z.strictObject({
  urls: z.array(z.string().trim().min(1).max(2048))
    .min(1)
    .max(importBatchHardLimit)
    .transform((urls) => [...new Set(urls)])
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

function galleryStatsSelector(noun: string) {
  return z.string().trim().toLowerCase().min(1).max(1024)
    .transform((value, ctx) => {
      const tokens = [...new Set(
        value.split(",").map((token) => token.trim()).filter(Boolean)
      )];
      if (
        tokens.length === 0
        || tokens.some((token) => {
          const slug = token.replace(/^!/, "");
          return slug.length > slugMaxLength || !slugPattern.test(slug);
        })
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${noun}筛选必须由合法的 slug 组成`
        });
        return z.NEVER;
      }
      const hasIncludes = tokens.some((token) => !token.startsWith("!"));
      const hasExcludes = tokens.some((token) => token.startsWith("!"));
      if (hasIncludes && hasExcludes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${noun}筛选不能混用包含与排除模式`
        });
        return z.NEVER;
      }
      return tokens.join(",");
    });
}

export const galleryStatsQuery = z.strictObject({
  d: z.enum(appConfig.devices).optional(),
  b: z.enum(appConfig.brightness).optional(),
  t: galleryStatsSelector("主题").optional(),
  tag: galleryStatsSelector("标签").optional(),
  a: galleryStatsSelector("作者").optional()
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
