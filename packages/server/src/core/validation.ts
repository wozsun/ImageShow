import { z } from "zod";
import { appConfig } from "@imageshow/shared";
import {
  adminImagePageLimit,
  adminPreferenceValueOptions,
  adminPreferencesMaxBytes,
  type ImageUpdateItemInputDto,
  ingestionBatchHardLimit,
  ingestionDuplicateDecisions,
  ingestionQueueActionTypes,
  ingestionQueueTypes,
  ingestionSourceTypes,
  ingestionStatusBatchMaxItems,
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

export const uuidV7Input = uuidInput.refine((value) => (
  value[14] === "7" && ["8", "9", "a", "b"].includes(value[19] ?? "")
), "必须使用 RFC 9562 UUIDv7");

export const ingestionSessionIdInput = z.string()
  .regex(/^[A-Za-z0-9_-]{43}$/u, "内容接入 session_id 无效");

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

const ingestionMetadataInput = metadataCreateInput.extend({
  tags: normalizedImageTagsInput.optional().default([])
});

const ingestionTimeFields = {
  image_time: z.string().trim().min(1).max(64).optional(),
  batch_time: z.string().trim().min(1).max(64).optional(),
  batch_position: z.number().int().min(0).max(0xfff)
};

export const uploadIntentInput = z.strictObject({
  items: z.array(ingestionMetadataInput.extend({
    idempotency_key: uuidV7Input,
    batch_key: uuidV7Input,
    ...ingestionTimeFields,
    storage_slug: storageSlugInput.optional(),
    expected_size: z.number().int().positive(),
    max_long_edge: z.number().int().positive()
  })).min(1).max(ingestionBatchHardLimit)
}).superRefine((value, ctx) => {
  addUniqueIdIssues(
    value.items.map((item) => item.idempotency_key),
    ctx,
    (index) => ["items", index, "idempotency_key"],
    "上传意图不能包含重复幂等键"
  );
  addUniqueIdIssues(
    value.items.map((item) => `${item.batch_key}\0${item.batch_position}`),
    ctx,
    (index) => ["items", index, "batch_position"],
    "同一上传批次不能包含重复批次位置"
  );
});

export const importAcceptInput = z.strictObject({
  items: z.array(ingestionMetadataInput.extend({
    idempotency_key: uuidV7Input,
    batch_key: uuidV7Input,
    source_type: z.enum(ingestionSourceTypes).exclude(["upload"]),
    download_url: optionalHttpsDomainUrlField(externalImageRejectedMessage)
      .refine(Boolean, externalImageRejectedMessage)
      .transform((value) => value!),
    ...ingestionTimeFields,
    manifest_line: z.number().int().min(1).max(1_000_000).optional(),
    storage_slug: storageSlugInput.optional()
  })).min(1).max(ingestionBatchHardLimit)
}).superRefine((value, ctx) => {
  addUniqueIdIssues(
    value.items.map((item) => item.idempotency_key),
    ctx,
    (index) => ["items", index, "idempotency_key"],
    "导入不能包含重复幂等键"
  );
  addUniqueIdIssues(
    value.items.map((item) => `${item.batch_key}\0${item.batch_position}`),
    ctx,
    (index) => ["items", index, "batch_position"],
    "同一导入批次不能包含重复批次位置"
  );
});

const ingestionPairInput = z.strictObject({
  session_id: ingestionSessionIdInput,
  image_id: uuidV7Input
});

function addUniqueIngestionPairIssues(
  items: readonly { session_id: string; image_id: string }[],
  ctx: z.RefinementCtx,
  field = "items"
) {
  addUniqueIdIssues(
    items.map(({ session_id, image_id }) => `${session_id}\0${image_id}`),
    ctx,
    (index) => [field, index, "session_id"],
    "请求不能包含重复内容接入任务"
  );
}

export const ingestionStatusInput = z.strictObject({
  items: z.array(ingestionPairInput).min(1).max(ingestionStatusBatchMaxItems)
}).superRefine((value, ctx) => addUniqueIngestionPairIssues(value.items, ctx));

export const ingestionSnapshotQuery = z.strictObject({
  queue: z.enum(ingestionQueueTypes),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(0)
    .max(appConfig.ingestionRuntime.snapshotMaxItems)
    .optional()
});

export const ingestionSnapshotSelectionInput = z.strictObject({
  exclude_items: z.array(ingestionPairInput).max(ingestionBatchHardLimit),
  include_items: z.array(ingestionPairInput)
    .max(appConfig.ingestionRuntime.snapshotMaxItems)
}).superRefine((value, ctx) => {
  addUniqueIngestionPairIssues(value.exclude_items, ctx, "exclude_items");
  addUniqueIngestionPairIssues(value.include_items, ctx, "include_items");
  addUniqueIdIssues(
    value.exclude_items.map((item) => item.session_id),
    ctx,
    (index) => ["exclude_items", index, "session_id"],
    "快照排除集合不能包含同一位置的多个 incarnation"
  );
  addUniqueIdIssues(
    value.include_items.map((item) => item.session_id),
    ctx,
    (index) => ["include_items", index, "session_id"],
    "快照补入集合不能包含同一位置的多个 incarnation"
  );
  const excluded = new Set(value.exclude_items.map((item) => (
    `${item.session_id}\0${item.image_id}`
  )));
  value.include_items.forEach((item, index) => {
    if (!excluded.has(`${item.session_id}\0${item.image_id}`)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["include_items", index, "session_id"],
        message: "补入任务必须属于当前文档排除集合"
      });
    }
  });
});

export const ingestionEventsQuery = z.strictObject({
  queue: z.enum(ingestionQueueTypes)
});

const expectedIngestionVersionInput = z.number().int().positive();

export const ingestionSessionUpdateInput = z.strictObject({
  items: z.array(ingestionPairInput.extend({
    expected_version: expectedIngestionVersionInput,
    metadata: ingestionMetadataInput.optional(),
    duplicate_decision: z.enum(ingestionDuplicateDecisions).optional()
  }).refine(
    (item) => item.metadata !== undefined || item.duplicate_decision !== undefined,
    "内容接入更新项必须包含 metadata 或重复项决定"
  )).min(1).max(ingestionBatchHardLimit)
}).superRefine((value, ctx) => addUniqueIngestionPairIssues(value.items, ctx));

export const ingestionDuplicateDetailsInput = z.strictObject({
  md5s: z.array(z.string().regex(/^[a-f0-9]{32}$/u))
    .min(1)
    .max(ingestionStatusBatchMaxItems)
}).superRefine((value, ctx) => {
  addUniqueIdIssues(
    value.md5s,
    ctx,
    (index) => ["md5s", index],
    "重复详情请求不能包含重复 MD5"
  );
});

export const ingestionCommitIntentInput = z.strictObject({
  items: z.array(ingestionPairInput.extend({
    expected_version: expectedIngestionVersionInput,
    expected_md5: z.string().regex(/^[a-f0-9]{32}$/u),
    commit_request_id: uuidV7Input,
    duplicate_decision: z.enum(ingestionDuplicateDecisions),
    metadata: ingestionMetadataInput
  })).min(1).max(ingestionBatchHardLimit)
}).superRefine((value, ctx) => {
  addUniqueIngestionPairIssues(value.items, ctx);
  addUniqueIdIssues(
    value.items.map((item) => item.commit_request_id),
    ctx,
    (index) => ["items", index, "commit_request_id"],
    "提交请求不能包含重复 commit_request_id"
  );
});

export const ingestionCancelInput = z.strictObject({
  items: z.array(ingestionPairInput.extend({
    expected_version: expectedIngestionVersionInput
  })).min(1).max(ingestionBatchHardLimit)
}).superRefine((value, ctx) => addUniqueIngestionPairIssues(value.items, ctx));

const ingestionActionMetadataInput = z.strictObject({
  ...metadataUpdateFields,
  tags: normalizedImageTagsInput.optional()
}).refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  "应用到全部必须包含至少一个属性"
);

export const ingestionQueueActionInput = z.strictObject({
  queue: z.enum(ingestionQueueTypes),
  action_request_id: uuidV7Input,
  action: z.enum(ingestionQueueActionTypes),
  action_watermark: z.string().min(1).max(appConfig.ingestionRuntime.tokenMaxBytes),
  continuation: z.string().min(1)
    .max(appConfig.ingestionRuntime.tokenMaxBytes)
    .optional(),
  metadata: ingestionActionMetadataInput.optional(),
  max_semantic_revision: z.number().int().nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
}).superRefine((value, ctx) => {
  if (value.action === "apply_metadata" && !value.metadata) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["metadata"],
      message: "应用到全部需要 metadata"
    });
  }
  if (value.action !== "apply_metadata" && value.metadata) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["metadata"],
      message: "当前全队列动作不接受 metadata"
    });
  }
  if (
    value.action !== "clear_completed"
    && value.max_semantic_revision !== undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_semantic_revision"],
      message: "当前全队列动作不接受 semantic revision 上限"
    });
  }
});

export const jsonlManifestInput = z.strictObject({
  content: z.string().min(1).max(appConfig.ingestion.jsonlManifestMaxBytes)
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= appConfig.ingestion.jsonlManifestMaxBytes,
      "JSONL 清单内容过大"
    )
});

export const weiboImportInput = z.strictObject({
  urls: z.array(z.string().trim().min(1).max(2048))
    .min(1)
    .max(ingestionBatchHardLimit)
    .transform((urls) => [...new Set(urls)])
});

const imageListFilterFields = {
  d: z.enum(appConfig.devices).optional(),
  b: z.enum(appConfig.brightnesses).optional(),
  t: z.string().trim().toLowerCase().max(1024).optional(),
  tag: z.string().trim().toLowerCase().max(1024).optional(),
  a: z.string().trim().toLowerCase().max(1024).optional()
};

const safePositiveInteger = z.coerce.number().int().positive().refine(
  Number.isSafeInteger,
  "必须是安全整数"
);

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

export const listQuery = z.strictObject({
  ...imageListFilterFields,
  status: z.literal("ready").default("ready"),
  // The image cursor decoder owns format validation and its stable API error.
  cursor: z.string().optional(),
  limit: safePositiveInteger.max(appConfig.pagination.maxLimit).optional(),
  shuffle: z.enum(["1", "true"]).optional().transform(Boolean)
});

export const adminImageListQuery = z.strictObject({
  ...imageListFilterFields,
  status: z.enum(["ready", "deleted"]).default("ready"),
  page: safePositiveInteger.default(1),
  limit: safePositiveInteger.max(appConfig.pagination.maxLimit).default(adminImagePageLimit)
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
