import type { AdminIconName } from "../../../../components/icon/AdminIcon.js";
import {
  parseImportUrlInput,
  type ImportUrlParseResult
} from "../queue/model/ingestion-job-utils.js";
import {
  parseImportJsonl,
  parseWeiboImport,
  type JsonlManifestResult,
  type WeiboImportResult
} from "../queue/ingestion-api.js";
import {
  formatUrlImportSummary,
  parseWeiboImportLines,
  type ImportSourceMode
} from "./import-source-model.js";

export type ImportSourceSubmission =
  | { mode: "urls"; urls: string[] }
  | { mode: "jsonl"; manifest: JsonlManifestResult }
  | { mode: "weibo"; result: WeiboImportResult };

type ParsedImportSourceBase = {
  submission: ImportSourceSubmission | null;
  blockingIssueCount: number;
  submitCount: number;
  summary: string;
};

export type ParsedImportSourceResult =
  | (ParsedImportSourceBase & {
      mode: "urls";
      result: ImportUrlParseResult;
    })
  | (ParsedImportSourceBase & {
      mode: "jsonl";
      manifest: JsonlManifestResult;
    })
  | (ParsedImportSourceBase & {
      mode: "weibo";
      result: WeiboImportResult;
    });

export type ImportSourceModeAdapter = {
  presentation: {
    heading: string;
    icon: AdminIconName;
    label: string;
    placeholder: string;
  };
  emptySubmitText: string;
  parseText: string;
  hint: (maxItems: number) => string;
  hasInput: (text: string) => boolean;
  parse: (
    text: string,
    signal: AbortSignal,
    urlResult?: ImportUrlParseResult
  ) => Promise<ParsedImportSourceResult>;
};

function jsonlResultSummary(result: JsonlManifestResult) {
  if (!result.items.length) return "没有可导入的有效清单项";
  const invalidPart = result.errors.length
    ? `、无效 ${result.errors.length}`
    : "";
  return `共解析 ${result.items.length + result.errors.length} 行，其中有效 ${result.items.length}${invalidPart}`;
}

function weiboResultSummary(result: WeiboImportResult) {
  if (!result.manifest.items.length) return "没有可导入的微博图片";
  const issueCount = result.errors.length + result.manifest.errors.length;
  const issuePart = issueCount ? `，另有 ${issueCount} 项失败` : "";
  return `已解析 ${result.post_count} 条微博，共 ${result.manifest.items.length} 张可导入图片${issuePart}`;
}

const urlsAdapter: ImportSourceModeAdapter = {
  presentation: {
    heading: "链接导入",
    icon: "link",
    label: "URL 列表",
    placeholder: "https://example.com/a.jpg\nhttps://example.com/b.png"
  },
  emptySubmitText: "无有效链接",
  parseText: "解析链接",
  hint: (maxItems) => (
    `每行一个 URL，最多 ${maxItems} 条；图片属性使用当前默认属性。`
  ),
  hasInput: (text) => Boolean(text.trim()),
  parse: async (text, _signal, urlResult) => {
    const result = urlResult ?? parseImportUrlInput(text);
    return {
      mode: "urls",
      result,
      submission: result.urls.length
        ? { mode: "urls", urls: result.urls }
        : null,
      blockingIssueCount: result.invalidCount,
      submitCount: result.urls.length,
      summary: result.urls.length
        ? formatUrlImportSummary(result)
        : "没有可导入的有效链接"
    };
  }
};

const jsonlAdapter: ImportSourceModeAdapter = {
  presentation: {
    heading: "清单导入",
    icon: "file-list-line",
    label: "JSONL 清单",
    placeholder: '{"original":"https://img.example.com/a.jpg","source":"https://example.com/post/1","image_time":"2020-05-01T00:00:00+08:00","tags":["2020"]}'
  },
  emptySubmitText: "无有效清单",
  parseText: "解析清单",
  hint: (maxItems) => (
    `每行一个 JSON，最多 ${maxItems} 条；行内字段优先于默认属性。`
  ),
  hasInput: (text) => Boolean(text.trim()),
  parse: async (text, signal) => {
    const manifest = await parseImportJsonl(text, signal);
    return {
      mode: "jsonl",
      manifest,
      submission: manifest.items.length
        ? { mode: "jsonl", manifest }
        : null,
      blockingIssueCount: manifest.errors.length,
      submitCount: manifest.items.length,
      summary: jsonlResultSummary(manifest)
    };
  }
};

const weiboAdapter: ImportSourceModeAdapter = {
  presentation: {
    heading: "微博导入",
    icon: "weibo-line",
    label: "微博链接",
    placeholder: "https://weibo.com/用户ID/微博短码\nhttps://weibo.com/用户ID/另一条微博"
  },
  emptySubmitText: "无微博图片",
  parseText: "解析微博",
  hint: (maxItems) => (
    `每行一条公开微博链接，最多 ${maxItems} 条；默认使用微博元数据。`
  ),
  hasInput: (text) => parseWeiboImportLines(text).length > 0,
  parse: async (text, signal) => {
    const inputLines = parseWeiboImportLines(text);
    const result = await parseWeiboImport(
      inputLines.map((entry) => entry.url),
      signal
    );
    const normalizedResult: WeiboImportResult = {
      ...result,
      errors: result.errors.map((error) => ({
        ...error,
        line: inputLines[error.line - 1]?.line ?? error.line
      }))
    };
    return {
      mode: "weibo",
      result: normalizedResult,
      submission: normalizedResult.manifest.items.length
        ? { mode: "weibo", result: normalizedResult }
        : null,
      blockingIssueCount:
        normalizedResult.errors.length
        + normalizedResult.manifest.errors.length,
      submitCount: normalizedResult.manifest.items.length,
      summary: weiboResultSummary(normalizedResult)
    };
  }
};

export const importSourceModeAdapters: Record<
  ImportSourceMode,
  ImportSourceModeAdapter
> = {
  urls: urlsAdapter,
  jsonl: jsonlAdapter,
  weibo: weiboAdapter
};
