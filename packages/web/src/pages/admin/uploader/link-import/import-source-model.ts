import { importBatchHardLimit } from "@imageshow/shared/browser";
import type {
  ImportUrlParseIssue,
  ImportUrlParseResult
} from "../import-job-utils.js";

export type ImportSourceMode = "urls" | "jsonl" | "weibo";

export const importSourceTextareaRows = 9;
const urlIssuePreviewRawMaxLength = 500;

export function formatUrlImportSummary(result: ImportUrlParseResult) {
  const totalCount = result.urls.length + result.invalidCount + result.duplicateCount;
  const categoryParts = [
    `有效 ${result.urls.length}`,
    result.invalidCount > 0 ? `无效 ${result.invalidCount}` : "",
    result.duplicateCount > 0 ? `重复 ${result.duplicateCount}` : ""
  ].filter(Boolean);

  return `共解析 ${totalCount} 项，其中${categoryParts.join("、")}`;
}

function urlImportIssueMessage(issue: ImportUrlParseIssue) {
  return issue.type === "duplicate"
    ? `与第 ${issue.firstLine} 行重复`
    : "不是有效的 HTTPS 图片 URL";
}

export function urlImportIssuePreviewMessage(issue: ImportUrlParseIssue) {
  const raw = issue.raw.length <= urlIssuePreviewRawMaxLength
    ? issue.raw
    : `${issue.raw.slice(0, urlIssuePreviewRawMaxLength)}...`;
  return `${urlImportIssueMessage(issue)}：${raw}`;
}

export function urlImportIssueText(issues: ImportUrlParseIssue[]) {
  return issues
    .map((issue) => `第 ${issue.line} 行：${urlImportIssueMessage(issue)}\n${issue.raw}`)
    .join("\n\n");
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

export function importSourceLimitState(
  mode: ImportSourceMode,
  text: string,
  limits: { link: number; weibo: number },
  urlParseResult: ImportUrlParseResult | null = null
) {
  const count = mode === "urls"
    ? urlParseResult
      ? urlParseResult.urls.length + urlParseResult.invalidCount + urlParseResult.duplicateCount
      : countNonEmptyInputItems(text)
    : mode === "weibo"
      ? parseWeiboImportUrls(text).length
      : text.split(/\r?\n/).filter((line) => line.trim()).length;
  const maxItems = Math.min(
    importBatchHardLimit,
    mode === "weibo" ? limits.weibo : limits.link
  );
  const overLimit = count > maxItems;
  return { count, maxItems, overLimit };
}
