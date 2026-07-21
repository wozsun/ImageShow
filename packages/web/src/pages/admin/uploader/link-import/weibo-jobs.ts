import type { ImportJob } from "../../../../lib/types.js";
import type { ImportAttributeDefaults } from "../../../../lib/upload/upload-utils.js";
import type { JsonlManifestItem } from "../import-api.js";
import { jsonlImportJobs } from "./jsonl-jobs.js";

export function weiboImportJobs(
  items: JsonlManifestItem[],
  defaults: ImportAttributeDefaults,
  storageSlug: string
): ImportJob[] {
  return jsonlImportJobs(
    items,
    defaults,
    storageSlug
  ).map((job) => ({
    ...job,
    manifestSource: "weibo"
  }));
}
