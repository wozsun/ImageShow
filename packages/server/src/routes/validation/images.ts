import { z } from "zod";
import { appConfig } from "@imageshow/shared";
import {
  adminImagePageLimit,
  type ImageUpdateItemInputDto,
  type ImageUpdateRequestDto,
  slugMaxLength,
  slugPattern
} from "@imageshow/shared/browser";
import { isHttpsUrl } from "../../core/url-validation.ts";
import { normalizedImageTagSlugsSchema } from "../../images/metadata-tags.ts";
import type { AdminImageListQuery } from "../../images/read-models/admin-images.ts";
import type { GalleryStatsQuery } from "../../images/read-models/gallery-stats.ts";
import type { PublicImageListQuery } from "../../images/read-models/public-images.ts";
import {
  addDuplicateValueIssues,
  requestUrlInput,
  safePositiveIntegerInput,
  uuidInput
} from "./primitives.ts";
import { storageSlugInput } from "./storage.ts";

const externalImageRejectedMessage = "外部图片请求未通过安全校验";
const classificationDevices = [...appConfig.devices, "auto"] as const;
const classificationBrightnesses = [
  ...appConfig.brightnesses,
  "auto"
] as const;

const imageMetadataFieldInputs = {
  device: z.enum(classificationDevices),
  brightness: z.enum(classificationBrightnesses),
  theme: z.string().trim().toLowerCase().min(1)
    .max(appConfig.themeMaxLength).regex(slugPattern),
  author: z.string().trim().toLowerCase().max(slugMaxLength)
    .refine(
      (value) => value === "" || slugPattern.test(value),
      "author must be a lowercase slug"
    ),
  title: z.string().trim().max(appConfig.imageMetadata.titleMaxLength),
  description: z.string().trim()
    .max(appConfig.imageMetadata.descriptionMaxLength),
  source: requestUrlInput("来源页面链接需为有效的 HTTPS 链接"),
  original: requestUrlInput(externalImageRejectedMessage)
    .refine(
      (value) => !value || isHttpsUrl(value, { requireDomain: true }),
      externalImageRejectedMessage
    )
};

export const imageMetadataCreateInput = z.strictObject({
  device: imageMetadataFieldInputs.device,
  brightness: imageMetadataFieldInputs.brightness,
  theme: imageMetadataFieldInputs.theme.default("none"),
  author: imageMetadataFieldInputs.author.default(""),
  title: imageMetadataFieldInputs.title.default(""),
  description: imageMetadataFieldInputs.description.default(""),
  source: imageMetadataFieldInputs.source.default(""),
  original: imageMetadataFieldInputs.original.default("")
});

export const imageMetadataUpdateFields = {
  device: imageMetadataFieldInputs.device.optional(),
  brightness: imageMetadataFieldInputs.brightness.optional(),
  theme: imageMetadataFieldInputs.theme.optional(),
  author: imageMetadataFieldInputs.author.optional(),
  title: imageMetadataFieldInputs.title.optional(),
  description: imageMetadataFieldInputs.description.optional(),
  source: imageMetadataFieldInputs.source.optional(),
  original: imageMetadataFieldInputs.original.optional()
};

const imageUpdateItemInput = z.strictObject({
  ...imageMetadataUpdateFields,
  id: uuidInput,
  tags: normalizedImageTagSlugsSchema.optional()
}).superRefine((value, context) => {
  const hasMetadataUpdate = Object.entries(value).some(
    ([key, fieldValue]) => (
      key !== "id" && key !== "tags" && fieldValue !== undefined
    )
  );
  if (!hasMetadataUpdate && value.tags === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "图片更新项必须包含 metadata 或 tags"
    });
  }
}) satisfies z.ZodType<ImageUpdateItemInputDto>;

export const imageUpdateInput = z.strictObject({
  items: z.array(imageUpdateItemInput).min(1).max(200)
}).superRefine((value, context) => {
  addDuplicateValueIssues(
    value.items.map((item) => item.id),
    context,
    (index) => ["items", index, "id"],
    "图片更新请求不能包含重复 ID"
  );
}) satisfies z.ZodType<ImageUpdateRequestDto>;

const uniqueImageIdsInput = z.array(uuidInput).min(1).max(200)
  .superRefine((ids, context) => {
    addDuplicateValueIssues(
      ids,
      context,
      (index) => [index],
      "请求不能包含重复 ID"
    );
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

export const imageStorageMigrationInput = z.strictObject({
  ids: uniqueImageIdsInput,
  target: storageSlugInput
});

const imageListFilterFields = {
  device: z.enum(appConfig.devices).optional(),
  brightness: z.enum(appConfig.brightnesses).optional(),
  theme: z.string().trim().toLowerCase().max(1024).optional(),
  tag: z.string().trim().toLowerCase().max(1024).optional(),
  author: z.string().trim().toLowerCase().max(1024).optional()
};

function galleryStatsSelector(noun: string) {
  return z.string().trim().toLowerCase().min(1).max(1024)
    .transform((value, context) => {
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
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: noun + "筛选必须由合法的 slug 组成"
        });
        return z.NEVER;
      }
      const hasIncludes = tokens.some((token) => !token.startsWith("!"));
      const hasExcludes = tokens.some((token) => token.startsWith("!"));
      if (hasIncludes && hasExcludes) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: noun + "筛选不能混用包含与排除模式"
        });
        return z.NEVER;
      }
      return tokens.join(",");
    });
}

export const galleryStatsQuery = z.strictObject({
  device: z.enum(appConfig.devices).optional(),
  brightness: z.enum(appConfig.brightnesses).optional(),
  theme: galleryStatsSelector("主题").optional(),
  tag: galleryStatsSelector("标签").optional(),
  author: galleryStatsSelector("作者").optional()
}) satisfies z.ZodType<GalleryStatsQuery>;

export const listQuery = z.strictObject({
  ...imageListFilterFields,
  status: z.literal("ready").default("ready"),
  // The image cursor decoder owns format validation and its stable API error.
  cursor: z.string().optional(),
  limit: safePositiveIntegerInput
    .max(appConfig.pagination.maxLimit).optional(),
  shuffle: z.enum(["1", "true"]).optional().transform(Boolean)
}) satisfies z.ZodType<PublicImageListQuery>;

export const adminImageListQuery = z.strictObject({
  ...imageListFilterFields,
  status: z.enum(["ready", "deleted"]).default("ready"),
  page: safePositiveIntegerInput.default(1),
  limit: safePositiveIntegerInput.max(appConfig.pagination.maxLimit)
    .default(adminImagePageLimit)
}) satisfies z.ZodType<AdminImageListQuery>;
