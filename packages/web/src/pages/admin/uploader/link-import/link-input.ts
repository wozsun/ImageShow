import { importBatchHardLimit } from "@imageshow/shared/browser";
import { parseImportUrls } from "../import-job-utils.js";

export type LinkInputMode = "urls" | "jsonl" | "weibo";

export const linkInputTextareaRows = 9;

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

export function linkInputLimitState(
  inputMode: LinkInputMode,
  text: string,
  limits: { link: number; weibo: number }
) {
  const count = inputMode === "urls"
    ? parseImportUrls(text).length
    : inputMode === "weibo"
      ? parseWeiboImportUrls(text).length
      : text.split(/\r?\n/).filter((line) => line.trim()).length;
  const maxItems = Math.min(
    importBatchHardLimit,
    inputMode === "weibo" ? limits.weibo : limits.link
  );
  return { count, maxItems, overLimit: count > maxItems };
}
