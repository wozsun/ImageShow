import { z } from "zod";
import { appConfig } from "@imageshow/shared";
import {
  adminImagePageLimit,
  adminPreferenceValueOptions,
  adminPreferencesMaxBytes,
  type ImageUpdateItemInputDto,
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
const classificationBrightnesses = [...appConfig.brightnesses, "auto"] as const;

const metadataFieldInputs = {
  device: z.enum(classificationDevices),
  brightness: z.enum(classificationBrightnesses),
  theme: z.string().trim().toLowerCase().min(1).max(appConfig.themeMaxLength).regex(slugPattern),
  author: z.string().trim().toLowerCase().max(slugMaxLength)
    .refine((value) => value === "" || slugPattern.test(value), "author must be a lowercase slug"),
  title: z.string().trim().max(appConfig.imageMetadata.titleMaxLength),
  description: z.string().trim().max(appConfig.imageMetadata.descriptionMaxLength),
  source: urlBase("来源页面链接需为有效的 HTTPS 链接"),
  original: urlBase(externalImageRejectedMessage)
    .refine((value) => !value || isHttpsUrl(value, { requireDomain: true }), externalImageRejectedMessage)
};

const metadataCreateInput = z.strictObject({
  device: metadataFieldInputs.device,
  brightness: metadataFieldInputs.brightness,
  theme: metadataFieldInputs.theme.default("none"),
  author: metadataFieldInputs.author.default(""),
  title: metadataFieldInputs.title.default(""),
  description: metadataFieldInputs.description.default(""),
  source: metadataFieldInputs.source.default(""),
  original: metadataFieldInputs.original.default("")
});

const metadataUpdateFields = {
  device: metadataFieldInputs.device.optional(),
  brightness: metadataFieldInputs.brightness.optional(),
  theme: metadataFieldInputs.theme.optional(),
  author: metadataFieldInputs.author.optional(),
  title: metadataFieldInputs.title.optional(),
  description: metadataFieldInputs.description.optional(),
  source: metadataFieldInputs.source.optional(),
  original: metadataFieldInputs.original.optional()
};

function hasDefinedField(value: Record<string, unknown>) {
  return Object.values(value).some((field) => field !== undefined);
}

export const metadataUpdateInput = z.strictObject(metadataUpdateFields)
  .refine(hasDefinedField, "图片更新至少需要提供一个字段");

const slugInput = z.string().trim().toLowerCase()
  .min(1, "标识 slug 不能为空")
  .max(slugMaxLength, `标识 slug 最长 ${slugMaxLength} 个字符`)
  .regex(slugPattern, "标识 slug 只能包含小写字母、数字、连字符，且不能以连字符开头或结尾");
const displayNameInput = z.string().trim().max(
  vocabularyDisplayNameMaxLength,
  `显示名最长 ${vocabularyDisplayNameMaxLength} 个字符`
);

export const tagSlugInput = slugInput;
export const tagCreateInput = z.strictObject({ slug: tagSlugInput, display_name: displayNameInput.optional().default("") });
export const tagDisplayUpdateInput = z.strictObject({ display_name: displayNameInput });

export const themeSlugInput = slugInput;
const themeDisplayInput = displayNameInput;

export const slugListInput = z.strictObject({
  slugs: z.array(slugInput).min(1).max(2000).transform((slugs) => [...new Set(slugs)])
});
export const themeCreateInput = z.strictObject({ slug: themeSlugInput, display_name: themeDisplayInput.optional().default("") });
export const themeDisplayUpdateInput = z.strictObject({ display_name: themeDisplayInput });

export const authorSlugInput = slugInput;
const authorLinkInput = httpsUrlField("作者主页链接需为有效的 HTTPS 链接");
export const authorCreateInput = z.strictObject({ slug: authorSlugInput, display_name: displayNameInput.optional().default(""), link: authorLinkInput });
export const authorMetaUpdateInput = z.strictObject({ display_name: displayNameInput, link: authorLinkInput });

export const uuidInput = z.string().uuid().transform((value) => value.toLowerCase());

export const normalizedImageTagsInput = z.array(tagSlugInput)
  // The public limit applies after normalization, so repeated spellings do not
  // consume the per-image tag allowance.
  .transform((tags) => [...new Set(tags)])
  .pipe(z.array(tagSlugInput).max(50));

const imageUpdateItemInput = z.strictObject({
  ...metadataUpdateFields,
  id: uuidInput,
  tags: normalizedImageTagsInput.optional(),
}).superRefine((value, ctx) => {
  const hasMetadataUpdate = Object.entries(value).some(([key, fieldValue]) =>
    key !== "id" && key !== "tags" && fieldValue !== undefined
  );
  if (!hasMetadataUpdate && value.tags === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "图片更新项必须包含 metadata 或 tags",
    });
  }
});

export type ImageUpdateItemInput = ImageUpdateItemInputDto;

function addUniqueIdIssues(
  ids: readonly string[],
  ctx: z.RefinementCtx,
  issuePath: (index: number) => PropertyKey[],
  message: string
) {
  const seen = new Set<string>();
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    if (seen.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: issuePath(index),
        message,
      });
    }
    seen.add(id);
  }
}

export const imageUpdateInput = z.strictObject({
  items: z.array(imageUpdateItemInput).min(1).max(200),
}).superRefine((value, ctx) => {
  addUniqueIdIssues(
    value.items.map((item) => item.id),
    ctx,
    (index) => ["items", index, "id"],
    "图片更新请求不能包含重复 ID"
  );
});

export const userCreateInput = z.strictObject({ username: adminUsernameInput, password: adminPasswordInput });
export const userPasswordInput = z.strictObject({ password: adminPasswordInput });

export const passwordChangeInput = z.strictObject({
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

const uniqueImageIdsInput = z.array(uuidInput).min(1).max(200)
  .superRefine((ids, ctx) => {
    addUniqueIdIssues(ids, ctx, (index) => [index], "请求不能包含重复 ID");
  });

export const imageActionInput = z.strictObject({
  ids: uniqueImageIdsInput
});

export const imageSnapshotInput = z.strictObject({
  ids: uniqueImageIdsInput
});

export const imagePurgeInput = z.discriminatedUnion("scope", [
  z.strictObject({
    scope: z.literal("selected"),
    ids: uniqueImageIdsInput
  }),
  z.strictObject({
    scope: z.literal("all")
  })
]);

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

export const imageStorageMigrationInput = z.strictObject({
  ids: uniqueImageIdsInput,
  target: storageSlugInput
});

export const importCreateInput = metadataCreateInput.extend({
  mode: z.enum(importModes),
  source_url: optionalHttpsDomainUrlField(externalImageRejectedMessage),
  image_time: z.string().trim().min(1).max(64).optional(),
  batch_time: z.string().trim().min(1).max(64).optional(),
  manifest_position: z.number().int().min(0).max(0xfff).optional(),
  size: z.number().int().positive().optional(),
  idempotency_key: z.string().uuid(),
  tags: normalizedImageTagsInput.optional().default([]),
  storage_slug: storageSlugInput.optional()
}).superRefine((value, ctx) => {
  if (value.mode === "upload" && !value.size) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["size"], message: "上传模式需要文件大小" });
  }
  if (value.mode === "download" && !value.source_url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source_url"], message: "链接导入模式需要图片链接" });
  }
});

const importCommitInput = metadataCreateInput.extend({
  tags: normalizedImageTagsInput.optional().default([])
});

export const importBatchCommitInput = z.strictObject({
  items: z.array(z.strictObject({
    id: uuidInput,
    metadata: importCommitInput
  })).min(1).max(importBatchHardLimit)
}).superRefine((value, ctx) => {
  addUniqueIdIssues(
    value.items.map((item) => item.id),
    ctx,
    (index) => ["items", index, "id"],
    "导入批次不能包含重复 ID"
  );
});

export const jsonlManifestInput = z.strictObject({
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
  b: z.enum(appConfig.brightnesses).optional(),
  t: z.string().trim().toLowerCase().max(1024).optional(),
  tag: z.string().trim().toLowerCase().max(1024).optional(),
  a: z.string().trim().toLowerCase().max(1024).optional(),
  // The image cursor decoder owns format validation and its stable API error.
  cursor: z.string().optional()
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
  b: z.enum(appConfig.brightnesses).optional(),
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
