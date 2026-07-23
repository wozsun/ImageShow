import type { ImageDraft, ImportJob, ManifestImportSource } from "../../../lib/types.js";
import {
  browserUuid,
  type ImportAttributeDefaults
} from "../../../lib/upload/upload-utils.js";

const externalImageUrlMaxLength = 2048;

function hasDirectIpHostname(hostname: string) {
  const unwrappedHostname = hostname.replace(/^\[|\]$/g, "");
  return unwrappedHostname.includes(":") || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(unwrappedHostname);
}

function isPlausibleExternalImageUrl(value: string) {
  if (value.length > externalImageUrlMaxLength) return false;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return parsed.protocol === "https:"
      && Boolean(hostname)
      && !parsed.username
      && !parsed.password
      && hostname !== "localhost"
      && !hostname.endsWith(".localhost")
      && hostname !== "metadata"
      && hostname !== "metadata.google.internal"
      && !hasDirectIpHostname(hostname);
  } catch {
    return false;
  }
}

export type ImportUrlParseIssue =
  | {
    type: "invalid";
    line: number;
    raw: string;
  }
  | {
    type: "duplicate";
    line: number;
    raw: string;
    firstLine: number;
  };

export type ImportUrlParseResult = {
  urls: string[];
  invalidCount: number;
  duplicateCount: number;
  issues: ImportUrlParseIssue[];
};

export function importPositionText(item: {
  manifestSource?: ManifestImportSource;
  manifestLine?: number;
  manifestPosition?: number;
}) {
  if (item.manifestSource === "weibo") {
    const position = item.manifestPosition
      ?? (item.manifestLine ? item.manifestLine - 1 : undefined);
    return position === undefined ? "" : `微博第 ${position + 1} 张`;
  }
  return item.manifestLine ? `JSONL 第 ${item.manifestLine} 行` : "";
}

export function parseImportUrlInput(input: string | string[]): ImportUrlParseResult {
  const lines = Array.isArray(input) ? input : input.split(/\r?\n/);
  const urls: string[] = [];
  let invalidCount = 0;
  let duplicateCount = 0;
  const issues: ImportUrlParseIssue[] = [];
  const firstLineByUrl = new Map<string, number>();

  for (const [lineIndex, value] of lines.entries()) {
    // 保留既有的空白分隔兼容，同时把每个值关联到其输入行；界面仍引导每行一个 URL。
    for (const raw of value.split(/\s+/)) {
      const url = raw.trim();
      if (!url) continue;
      const line = lineIndex + 1;
      if (!isPlausibleExternalImageUrl(url)) {
        invalidCount += 1;
        issues.push({ type: "invalid", line, raw });
        continue;
      }
      const firstLine = firstLineByUrl.get(url);
      if (firstLine !== undefined) {
        duplicateCount += 1;
        issues.push({ type: "duplicate", line, raw, firstLine });
        continue;
      }
      firstLineByUrl.set(url, line);
      urls.push(url);
    }
  }

  return { urls, invalidCount, duplicateCount, issues };
}

function linkDraft(
  url: string,
  defaults: ImportAttributeDefaults,
  fillOriginalUrl: boolean
): ImageDraft {
  return {
    title: "",
    description: "",
    source: "",
    original: fillOriginalUrl ? url : "",
    device: defaults.device,
    brightness: defaults.brightness,
    theme: defaults.theme,
    author: defaults.author,
    tags: [...defaults.tags]
  };
}

export function linkImportJobs(
  validatedUrls: string[],
  defaults: ImportAttributeDefaults,
  fillOriginalUrl: boolean,
  storageSlug: string
) {
  const batchTime = new Date().toISOString();
  return validatedUrls.map((url, manifestPosition): ImportJob => ({
    id: browserUuid(),
    attemptKey: browserUuid(),
    kind: "download",
    status: "queued",
    message: "等待下载",
    preview: "",
    draft: linkDraft(url, defaults, fillOriginalUrl),
    width: 0,
    height: 0,
    duplicates: [],
    duplicateDecision: "upload",
    url,
    storageSlug,
    batchTime,
    manifestPosition
  }));
}

export function retryPrepareJob(job: ImportJob): ImportJob {
  return {
    ...job,
    attemptKey: browserUuid(),
    sessionId: undefined,
    status: "queued",
    failureStage: undefined,
    commitFailureCheckpoint: undefined,
    message: "等待重试",
    transferProgress: undefined,
    md5: undefined,
    detectedClassification: undefined,
    classificationOverride: undefined,
    duplicates: [],
    duplicateDecision: "upload",
    batchDuplicate: undefined,
    finalSize: undefined,
    quality: undefined,
    transcoded: undefined
  };
}

export function retryLinkPrepareJob(job: ImportJob): ImportJob {
  if (job.failureStage !== "create" || job.sessionId) return retryPrepareJob(job);
  return {
    ...retryPrepareJob(job),
    attemptKey: job.attemptKey,
    status: "queued",
    message: "重新获取导入会话",
  };
}
