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

function normalizeImportSourceUrl(value: string) {
  if (value.length > externalImageUrlMaxLength) return null;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    const allowed = parsed.protocol === "https:"
      && Boolean(hostname)
      && !parsed.username
      && !parsed.password
      && hostname !== "localhost"
      && !hostname.endsWith(".localhost")
      && hostname !== "metadata"
      && hostname !== "metadata.google.internal"
      && !hasDirectIpHostname(hostname);
    if (!allowed) return null;
    parsed.hostname = hostname;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
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
      const normalizedUrl = normalizeImportSourceUrl(url);
      if (!normalizedUrl) {
        invalidCount += 1;
        issues.push({ type: "invalid", line, raw });
        continue;
      }
      const firstLine = firstLineByUrl.get(normalizedUrl);
      if (firstLine !== undefined) {
        duplicateCount += 1;
        issues.push({ type: "duplicate", line, raw, firstLine });
        continue;
      }
      firstLineByUrl.set(normalizedUrl, line);
      urls.push(normalizedUrl);
    }
  }

  return { urls, invalidCount, duplicateCount, issues };
}

export function localImportFileFingerprint(file: File) {
  // 浏览器不会暴露普通文件选择器中的绝对路径。目录选择时使用相对路径，
  // 其他入口以名称、大小和修改时间识别同一次选择的文件。
  return [
    file.webkitRelativePath || file.name,
    file.size,
    file.lastModified
  ].join("\u0000");
}

export function filterNewLocalImportFiles(
  existingJobs: readonly ImportJob[],
  files: readonly File[],
  reservedFingerprints: ReadonlySet<string> = new Set()
) {
  const fingerprints = new Set(
    existingJobs
      .filter((job) => job.kind === "local")
      .map((job) => job.fileFingerprint)
      .filter((fingerprint): fingerprint is string => Boolean(fingerprint))
  );
  for (const fingerprint of reservedFingerprints) fingerprints.add(fingerprint);
  return files.filter((file) => {
    const fingerprint = localImportFileFingerprint(file);
    if (fingerprints.has(fingerprint)) return false;
    fingerprints.add(fingerprint);
    return true;
  });
}

export function filterNewDownloadImportJobs(
  existingJobs: readonly ImportJob[],
  incomingJobs: readonly ImportJob[]
) {
  const sourceUrls = new Set(
    existingJobs
      .filter((job) => job.kind === "download" && job.url)
      .map((job) => normalizeImportSourceUrl(job.url!))
      .filter((url): url is string => Boolean(url))
  );
  return incomingJobs.filter((job) => {
    if (job.kind !== "download" || !job.url) return true;
    const sourceUrl = normalizeImportSourceUrl(job.url);
    if (!sourceUrl) return true;
    if (sourceUrls.has(sourceUrl)) return false;
    sourceUrls.add(sourceUrl);
    return true;
  });
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
    previewPersistent: undefined,
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
