import type { Device, ImageDraft, ImportJob } from "../../../lib/types.js";
import { browserUuid, resolveUploadDefaultBrightness, type CommonImageAttributes } from "../../../lib/upload/upload-utils.js";

export function parseImportUrls(input: string | string[]) {
  const raw = Array.isArray(input) ? input : input.split(/\s+/);
  const seen = new Set<string>();
  return raw.map((url) => url.trim()).filter((url) => {
    if (!/^https:\/\//i.test(url) || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
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
  urls: string[],
  defaults: CommonImageAttributes,
  fillOriginalUrl: boolean,
  storageSlug: string
) {
  const batchTime = new Date().toISOString();
  return parseImportUrls(urls).map((url, manifestPosition): ImportJob => ({
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
