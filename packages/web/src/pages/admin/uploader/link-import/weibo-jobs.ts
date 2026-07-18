import type { ImportJob } from "../../../../lib/types.js";
import type { CommonImageAttributes } from "../../../../lib/upload/upload-utils.js";
import type { JsonlManifestItem } from "../import-api.js";
import { jsonlImportJobs } from "./jsonl-jobs.js";
import type { LinkImportMode } from "./LinkUrlDialog.js";

/**
 * 微博导入仍走 JSONL 任务构造器，但 author 只允许来自用户 ID 映射。
 * 没有映射时保持空值，避免窗口中残留的默认作者被隐式带入。
 */
export function weiboImportJobs(
  items: JsonlManifestItem[],
  defaults: CommonImageAttributes,
  mode: LinkImportMode,
  storageSlug: string
): ImportJob[] {
  return jsonlImportJobs(
    items,
    { ...defaults, author: "" },
    mode,
    storageSlug
  ).map((job) => ({
    ...job,
    manifestSource: "weibo",
    inlineMetadataFields: [...new Set([
      ...(job.inlineMetadataFields ?? []),
      "author" as const
    ])]
  }));
}
