import type { Device, ImageDraft, ImportJob, ManifestImportSource } from "../../../lib/types.js";
import { browserUuid, resolveUploadDefaultBrightness, type CommonImageAttributes } from "../../../lib/upload/upload-utils.js";

function hasDirectIpHostname(hostname: string) {
  const unwrappedHostname = hostname.replace(/^\[|\]$/g, "");
  return unwrappedHostname.includes(":") || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(unwrappedHostname);
}

function isPlausibleExternalImageUrl(value: string) {
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

export type ImportUrlParseResult = {
  urls: string[];
  invalidCount: number;
  duplicateCount: number;
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
  const raw = Array.isArray(input) ? input : input.split(/\s+/);
  const urls: string[] = [];
  let invalidCount = 0;
  let duplicateCount = 0;
  const seen = new Set<string>();

  for (const value of raw) {
    const url = value.trim();
    if (!url) continue;
    if (!isPlausibleExternalImageUrl(url)) {
      invalidCount += 1;
      continue;
    }
    if (seen.has(url)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(url);
    urls.push(url);
  }

  return { urls, invalidCount, duplicateCount };
}

function linkDraft(url: string, defaults: CommonImageAttributes, fillOriginalUrl: boolean): ImageDraft {
  return {
    title: "",
    description: "",
    source: "",
    original: fillOriginalUrl ? url : "",
    device: defaults.device ? defaults.device as Device : "auto",
    brightness: resolveUploadDefaultBrightness(defaults.brightness, "auto"),
    theme: defaults.theme,
    author: defaults.author,
    tags: [...defaults.tags]
  };
}

export function linkImportJobs(
  kind: "download" | "proxy",
  validatedUrls: string[],
  defaults: CommonImageAttributes,
  fillOriginalUrl: boolean,
  storageSlug: string
) {
  const batchTime = new Date().toISOString();
  return validatedUrls.map((url, manifestPosition): ImportJob => ({
    id: browserUuid(),
    attemptKey: browserUuid(),
    kind,
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
    message: "等待重试",
    transferProgress: undefined
  };
}

export function retryLinkPrepareJob(job: ImportJob): ImportJob {
  if (job.failureStage !== "create" || job.sessionId) return retryPrepareJob(job);
  return {
    ...job,
    status: "queued",
    failureStage: undefined,
    message: "重新获取导入会话",
    transferProgress: undefined
  };
}
