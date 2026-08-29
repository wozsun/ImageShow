import type {
  ImageDraft,
  IngestionJob,
  ManifestImportSource
} from "../../../../../lib/types.js";
import type {
  IngestionAttributeDefaults
} from "./ingestion-attribute-defaults.js";
import {
  webIngestionBatchKey,
  webUuidV7
} from "./ingestion-identity.js";

const externalImageUrlMaxLength = 2048;

function hasDirectIpHostname(hostname: string) {
  const unwrappedHostname = hostname.replace(/^\[|\]$/g, "");
  return unwrappedHostname.includes(":")
    || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(unwrappedHostname);
}

export function normalizeImportDownloadUrl(value: string) {
  if (value.length > externalImageUrlMaxLength || /\s/.test(value)) return null;
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
  | { type: "invalid"; line: number; raw: string }
  | {
    type: "duplicate";
    line: number;
    raw: string;
    firstLine: number;
  };

export type ImportUrlParseResult = {
  urls: string[];
  candidateCount: number;
  invalidCount: number;
  duplicateCount: number;
  issues: ImportUrlParseIssue[];
};

export function importPositionText(item: {
  manifestSource?: ManifestImportSource;
  manifestLine?: number;
  batchPosition?: number;
}) {
  if (item.manifestSource === "weibo") {
    const position = item.batchPosition
      ?? (item.manifestLine ? item.manifestLine - 1 : undefined);
    return position === undefined ? "" : `微博第 ${position + 1} 张`;
  }
  return item.manifestLine ? `JSONL 第 ${item.manifestLine} 行` : "";
}

export function parseImportUrlInput(input: string): ImportUrlParseResult {
  const urls: string[] = [];
  let candidateCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;
  const issues: ImportUrlParseIssue[] = [];
  const firstLineByUrl = new Map<string, number>();

  for (const [lineIndex, value] of input.split(/\r?\n/).entries()) {
    const raw = value.trim();
    if (!raw) continue;
    candidateCount += 1;
    const line = lineIndex + 1;
    const normalizedUrl = normalizeImportDownloadUrl(raw);
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

  return { urls, candidateCount, invalidCount, duplicateCount, issues };
}

function createUrlImportDraft(
  downloadUrl: string,
  defaults: IngestionAttributeDefaults,
  retainOriginalLink: boolean
): ImageDraft {
  return {
    title: "",
    description: "",
    source: "",
    original: retainOriginalLink ? downloadUrl : "",
    device: defaults.device,
    brightness: defaults.brightness,
    theme: defaults.theme,
    author: defaults.author,
    tags: [...defaults.tags]
  };
}

export function createUrlImportJobs(
  validatedDownloadUrls: string[],
  defaults: IngestionAttributeDefaults,
  retainOriginalLink: boolean,
  storageSlug: string
) {
  const batchTime = new Date().toISOString();
  const batchKey = webIngestionBatchKey();
  return validatedDownloadUrls.map((downloadUrl, batchPosition): IngestionJob => ({
    id: webUuidV7(),
    attemptKey: webUuidV7(),
    batchKey,
    kind: "import",
    status: "queued",
    message: "等待下载",
    preview: "",
    draft: createUrlImportDraft(downloadUrl, defaults, retainOriginalLink),
    width: 0,
    height: 0,
    duplicates: [],
    duplicateDecision: "upload",
    downloadUrl,
    storageSlug,
    batchTime,
    batchPosition
  }));
}
