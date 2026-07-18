import { importBatchHardLimit } from "@imageshow/shared/browser";
import type { ImportUrlParseResult } from "../import-job-utils.js";

export type LinkInputMode = "urls" | "jsonl" | "weibo";

export const linkInputTextareaRows = 9;

export function formatUrlImportSummary(result: ImportUrlParseResult) {
  const totalCount = result.urls.length + result.invalidCount + result.duplicateCount;
  const categoryParts = [
    `有效 ${result.urls.length}`,
    result.invalidCount > 0 ? `无效 ${result.invalidCount}` : "",
    result.duplicateCount > 0 ? `重复 ${result.duplicateCount}` : ""
  ].filter(Boolean);

  return `共解析 ${totalCount} 项，其中${categoryParts.join("、")}`;
}

export type WeiboImportInputLine = {
  line: number;
  url: string;
};

export function parseWeiboImportLines(input: string): WeiboImportInputLine[] {
  const seen = new Set<string>();
  return input.split(/\r?\n/)
    .flatMap((value, index) => {
      const url = value.trim();
      if (!url || seen.has(url)) return [];
      seen.add(url);
      return [{ line: index + 1, url }];
    });
}

function parseWeiboImportUrls(input: string) {
  return parseWeiboImportLines(input).map((entry) => entry.url);
}

function countNonEmptyInputItems(input: string) {
  return input.split(/\s+/).filter(Boolean).length;
}

export function linkInputLimitState(
  inputMode: LinkInputMode,
  text: string,
  limits: { link: number; weibo: number },
  urlParseResult: ImportUrlParseResult | null = null
) {
  const count = inputMode === "urls"
    ? urlParseResult?.urls.length ?? countNonEmptyInputItems(text)
    : inputMode === "weibo"
      ? parseWeiboImportUrls(text).length
      : text.split(/\r?\n/).filter((line) => line.trim()).length;
  const maxItems = Math.min(
    importBatchHardLimit,
    inputMode === "weibo" ? limits.weibo : limits.link
  );
  const overLimit = inputMode === "urls"
    ? Boolean(urlParseResult && count > maxItems)
    : count > maxItems;
  return { count, maxItems, overLimit };
}
