import { importBatchHardLimit } from "@imageshow/shared";
import { parseImportUrls } from "../import-job-utils.js";

export type LinkInputMode = "urls" | "jsonl";

export const linkInputTextareaRows = 9;

export function linkInputLimitState(
  inputMode: LinkInputMode,
  text: string,
  limits: { urlList: number; jsonl: number }
) {
  const count = inputMode === "urls"
    ? parseImportUrls(text).length
    : text.split(/\r?\n/).filter((line) => line.trim()).length;
  const maxItems = Math.min(
    importBatchHardLimit,
    inputMode === "urls" ? limits.urlList : limits.jsonl
  );
  return { count, maxItems, overLimit: count > maxItems };
}
