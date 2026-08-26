import type { ImageDraft, IngestionJob, ManifestImportSource } from "../../../../../lib/types.js";
import type { IngestionAttributeDefaults } from "./ingestion-attribute-defaults.js";
import {
  webIngestionBatchKey,
  webUuidV7
} from "./ingestion-identity.js";

const externalImageUrlMaxLength = 2048;

function hasDirectIpHostname(hostname: string) {
  const unwrappedHostname = hostname.replace(/^\[|\]$/g, "");
  return unwrappedHostname.includes(":") || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(unwrappedHostname);
}

function normalizeImportSourceUrl(value: string) {
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
  candidateCount: number;
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
    const normalizedUrl = normalizeImportSourceUrl(raw);
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

export function uploadFileFingerprint(file: File) {
  // 浏览器不会暴露普通文件选择器中的绝对路径。目录选择时使用相对路径，
  // 其他入口以名称、大小和修改时间识别同一次选择的文件。
  return [
    file.webkitRelativePath || file.name,
    file.size,
    file.lastModified
  ].join("\u0000");
}

export function filterNewUploadFiles(
  existingJobs: readonly IngestionJob[],
  files: readonly File[],
  reservedFingerprints: ReadonlySet<string> = new Set()
) {
  const fingerprints = new Set(
    existingJobs
      .filter((job) => job.kind === "upload")
      .map((job) => job.fileFingerprint)
      .filter((fingerprint): fingerprint is string => Boolean(fingerprint))
  );
  for (const fingerprint of reservedFingerprints) fingerprints.add(fingerprint);
  return files.filter((file) => {
    const fingerprint = uploadFileFingerprint(file);
    if (fingerprints.has(fingerprint)) return false;
    fingerprints.add(fingerprint);
    return true;
  });
}

export function filterNewDownloadIngestionJobs(
  existingJobs: readonly IngestionJob[],
  incomingJobs: readonly IngestionJob[]
) {
  const sourceUrls = new Set(
    existingJobs
      .filter((job) => job.kind === "import" && job.url)
      .map((job) => normalizeImportSourceUrl(job.url!))
      .filter((url): url is string => Boolean(url))
  );
  return incomingJobs.filter((job) => {
    if (job.kind !== "import" || !job.url) return true;
    const sourceUrl = normalizeImportSourceUrl(job.url);
    if (!sourceUrl) return true;
    if (sourceUrls.has(sourceUrl)) return false;
    sourceUrls.add(sourceUrl);
    return true;
  });
}

function urlDraft(
  url: string,
  defaults: IngestionAttributeDefaults,
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

export function urlImportJobs(
  validatedUrls: string[],
  defaults: IngestionAttributeDefaults,
  fillOriginalUrl: boolean,
  storageSlug: string
) {
  const batchTime = new Date().toISOString();
  const subscriptionBatchKey = webIngestionBatchKey();
  return validatedUrls.map((url, manifestPosition): IngestionJob => ({
    id: webUuidV7(),
    attemptKey: webUuidV7(),
    subscriptionBatchKey,
    kind: "import",
    status: "queued",
    message: "等待下载",
    preview: "",
    draft: urlDraft(url, defaults, fillOriginalUrl),
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

export function retryPrepareJob(job: IngestionJob): IngestionJob {
  return {
    ...job,
    attemptKey: webUuidV7(),
    uploadIntentInput: undefined,
    importAcceptInput: undefined,
    sessionId: undefined,
    imageId: undefined,
    imageTime: undefined,
    serverVersion: undefined,
    serverProgressSeq: undefined,
    serverSemanticRevision: undefined,
    serverHandoffPending: undefined,
    serverHandoffRevision: undefined,
    serverHandoffDisplayPage: undefined,
    serverHandoffProvisionalTotal: undefined,
    serverAcceptedOrder: undefined,
    serverAccepted: undefined,
    serverDraftPending: undefined,
    serverStatus: undefined,
    serverPhase: undefined,
    serverError: undefined,
    serverProgress: undefined,
    serverAttemptKey: undefined,
    serverSessionId: undefined,
    serverImageId: undefined,
    browserDisplayReleased: undefined,
    status: "queued",
    failureStage: undefined,
    commitFailureCheckpoint: undefined,
    commitIntent: undefined,
    resultState: undefined,
    resultError: undefined,
    message: "等待重试",
    transferProgress: undefined,
    md5: undefined,
    preparedOrder: undefined,
    detectedClassification: undefined,
    classificationOverride: undefined,
    duplicates: [],
    duplicateCount: undefined,
    duplicateDecision: "upload",
    finalSize: undefined,
    quality: undefined,
    transcoded: undefined
  };
}

export function isUnconfirmedUploadRawAttempt(job: IngestionJob) {
  return job.kind === "upload"
    && job.failureStage === "prepare"
    && job.serverVersion === undefined
    && Boolean(job.sessionId && job.imageId);
}

export function retryImportPrepareJob(job: IngestionJob): IngestionJob {
  if (job.failureStage !== "create" || job.sessionId) {
    return retryPrepareJob(job);
  }
  return {
    ...retryPrepareJob(job),
    attemptKey: job.attemptKey,
    importAcceptInput: job.importAcceptInput,
    status: "queued",
    message: "重新获取内容接入会话",
  };
}
