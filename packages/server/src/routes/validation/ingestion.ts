import { z } from "zod";
import { appConfig } from "@imageshow/shared";
import {
  ingestionBatchHardLimit,
  type IngestionDraftUrlField,
  ingestionDuplicateDecisions,
  ingestionQueueActionTypes,
  ingestionQueueTypes,
  ingestionSourceTypes,
  ingestionStatusBatchMaxItems,
  normalizeIngestionDraftUrl
} from "@imageshow/shared/browser";
import { normalizedImageTagSlugsSchema } from "../../images/metadata-tags.ts";
import {
  imageMetadataCreateInput,
  imageMetadataUpdateFields
} from "./images.ts";
import {
  addDuplicateValueIssues,
  optionalHttpsDomainUrlField,
  uuidV7Input
} from "./primitives.ts";
import { storageSlugInput } from "./storage.ts";

const externalImageRejectedMessage = "外部图片请求未通过安全校验";

function ingestionDraftUrlField(field: IngestionDraftUrlField) {
  const label = field === "original" ? "原图" : "来源";
  return z.string().transform((value, context) => {
    const normalized = normalizeIngestionDraftUrl(field, value);
    if (normalized !== null) return normalized;
    context.addIssue({
      code: "custom",
      message: "内容接入草稿" + label + " URL 格式无效"
    });
    return z.NEVER;
  }).default("");
}

export const ingestionSessionIdInput = z.string()
  .regex(/^[A-Za-z0-9_-]{43}$/u, "内容接入 session_id 无效");

const ingestionMetadataInput = imageMetadataCreateInput.extend({
  tags: normalizedImageTagSlugsSchema.optional().default([])
});

const ingestionDraftMetadataInput = ingestionMetadataInput.extend({
  original: ingestionDraftUrlField("original"),
  source: ingestionDraftUrlField("source")
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
}).superRefine((value, context) => {
  addDuplicateValueIssues(
    value.items.map((item) => item.idempotency_key),
    context,
    (index) => ["items", index, "idempotency_key"],
    "上传意图不能包含重复幂等键"
  );
  addDuplicateValueIssues(
    value.items.map((item) => (
      item.batch_key + "\0" + item.batch_position
    )),
    context,
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
}).superRefine((value, context) => {
  addDuplicateValueIssues(
    value.items.map((item) => item.idempotency_key),
    context,
    (index) => ["items", index, "idempotency_key"],
    "导入不能包含重复幂等键"
  );
  addDuplicateValueIssues(
    value.items.map((item) => (
      item.batch_key + "\0" + item.batch_position
    )),
    context,
    (index) => ["items", index, "batch_position"],
    "同一导入批次不能包含重复批次位置"
  );
});

const ingestionPairInput = z.strictObject({
  session_id: ingestionSessionIdInput,
  image_id: uuidV7Input
});

function addDuplicateIngestionPairIssues(
  items: readonly { session_id: string; image_id: string }[],
  context: z.RefinementCtx,
  field = "items"
) {
  addDuplicateValueIssues(
    items.map(({ session_id, image_id }) => session_id + "\0" + image_id),
    context,
    (index) => [field, index, "session_id"],
    "请求不能包含重复内容接入任务"
  );
}

export const ingestionStatusInput = z.strictObject({
  items: z.array(ingestionPairInput).min(1)
    .max(ingestionStatusBatchMaxItems)
}).superRefine((value, context) => {
  addDuplicateIngestionPairIssues(value.items, context);
});

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
}).superRefine((value, context) => {
  addDuplicateIngestionPairIssues(
    value.exclude_items,
    context,
    "exclude_items"
  );
  addDuplicateIngestionPairIssues(
    value.include_items,
    context,
    "include_items"
  );
  addDuplicateValueIssues(
    value.exclude_items.map((item) => item.session_id),
    context,
    (index) => ["exclude_items", index, "session_id"],
    "快照排除集合不能包含同一位置的多个 incarnation"
  );
  addDuplicateValueIssues(
    value.include_items.map((item) => item.session_id),
    context,
    (index) => ["include_items", index, "session_id"],
    "快照补入集合不能包含同一位置的多个 incarnation"
  );
  const excluded = new Set(value.exclude_items.map((item) => (
    item.session_id + "\0" + item.image_id
  )));
  value.include_items.forEach((item, index) => {
    if (!excluded.has(item.session_id + "\0" + item.image_id)) {
      context.addIssue({
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
    metadata: ingestionDraftMetadataInput.optional(),
    duplicate_decision: z.enum(ingestionDuplicateDecisions).optional()
  }).refine(
    (item) => (
      item.metadata !== undefined || item.duplicate_decision !== undefined
    ),
    "内容接入更新项必须包含 metadata 或重复项决定"
  )).min(1).max(ingestionBatchHardLimit)
}).superRefine((value, context) => {
  addDuplicateIngestionPairIssues(value.items, context);
});

export const ingestionDuplicateDetailsInput = z.strictObject({
  md5s: z.array(z.string().regex(/^[a-f0-9]{32}$/u))
    .min(1)
    .max(ingestionStatusBatchMaxItems)
}).superRefine((value, context) => {
  addDuplicateValueIssues(
    value.md5s,
    context,
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
}).superRefine((value, context) => {
  addDuplicateIngestionPairIssues(value.items, context);
  addDuplicateValueIssues(
    value.items.map((item) => item.commit_request_id),
    context,
    (index) => ["items", index, "commit_request_id"],
    "提交请求不能包含重复 commit_request_id"
  );
});

export const ingestionCancelInput = z.strictObject({
  items: z.array(ingestionPairInput.extend({
    expected_version: expectedIngestionVersionInput
  })).min(1).max(ingestionBatchHardLimit)
}).superRefine((value, context) => {
  addDuplicateIngestionPairIssues(value.items, context);
});

const ingestionActionMetadataInput = z.strictObject({
  ...imageMetadataUpdateFields,
  tags: normalizedImageTagSlugsSchema.optional()
}).refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  "应用到全部必须包含至少一个属性"
);

export const ingestionQueueActionInput = z.strictObject({
  queue: z.enum(ingestionQueueTypes),
  action_request_id: uuidV7Input,
  action: z.enum(ingestionQueueActionTypes),
  action_watermark: z.string().min(1)
    .max(appConfig.ingestionRuntime.tokenMaxBytes),
  continuation: z.string().min(1)
    .max(appConfig.ingestionRuntime.tokenMaxBytes)
    .optional(),
  metadata: ingestionActionMetadataInput.optional(),
  max_semantic_revision: z.number().int().nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
}).superRefine((value, context) => {
  if (value.action === "apply_metadata" && !value.metadata) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["metadata"],
      message: "应用到全部需要 metadata"
    });
  }
  if (value.action !== "apply_metadata" && value.metadata) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["metadata"],
      message: "当前全队列动作不接受 metadata"
    });
  }
  if (
    value.action !== "clear_completed"
    && value.max_semantic_revision !== undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_semantic_revision"],
      message: "当前全队列动作不接受 semantic revision 上限"
    });
  }
});

export const jsonlManifestInput = z.strictObject({
  content: z.string().min(1).max(appConfig.ingestion.jsonlManifestMaxBytes)
    .refine(
      (value) => Buffer.byteLength(value, "utf8")
        <= appConfig.ingestion.jsonlManifestMaxBytes,
      "JSONL 清单内容过大"
    )
});

export const weiboImportInput = z.strictObject({
  urls: z.array(z.string().trim().min(1).max(2048))
    .min(1)
    .max(ingestionBatchHardLimit)
    .transform((urls) => [...new Set(urls)])
});
